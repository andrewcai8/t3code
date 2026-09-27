// @effect-diagnostics globalDate:off - stored hour buckets are re-bucketed by ISO instant.
/**
 * Usage a host keeps for its cloud boxes.
 *
 * Cloud chats write transcripts on an ephemeral box, so the host pulls each
 * box's hourly UTC history, stores its sources per lease and its buckets per
 * hour, and folds a window's hours into its own summary. Hour buckets
 * re-bucket exactly into any client's day or hour window.
 *
 * @module boxUsage
 */
import {
  ForwardCompatibleArray,
  UsageBucket,
  UsageSource,
  type UsageProviderKind,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { usageSourcePath } from "@t3tools/shared/usageMerge";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { compareUsageBuckets, makeDayFormatter } from "./usageAggregation.ts";
import { addTotals } from "./usageTranscripts.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A box's history exactly as the box reported it. */
export interface BoxUsage {
  readonly sources: ReadonlyArray<UsageSource>;
  readonly buckets: ReadonlyArray<UsageBucket>;
}

export interface StoredBoxUsage extends BoxUsage {
  readonly leaseId: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly pulledAt: string;
  /**
   * No client can still hold a summary from this box, so it needs no identity
   * of its own and folds into the host's shared cloud source.
   */
  readonly retired: boolean;
}

export class BoxUsageStoreError extends Schema.TaggedError<BoxUsageStoreError>()(
  "BoxUsageStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const SourcesJson = Schema.fromJsonString(ForwardCompatibleArray(UsageSource));
const AccountIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const BucketJson = Schema.fromJsonString(UsageBucket);
const encodeSources = Schema.encodeSync(SourcesJson);
const encodeAccountIds = Schema.encodeSync(AccountIdsJson);
const encodeBucket = Schema.encodeSync(BucketJson);
const decodeLeaseRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    leaseId: Schema.String,
    accountIds: AccountIdsJson,
    sources: SourcesJson,
    pulledAt: Schema.String,
    retired: Schema.Number,
  }),
);
const decodeHourRow = Schema.decodeUnknownEffect(
  Schema.Struct({ leaseId: Schema.String, bucket: BucketJson }),
);

/** Keeps each multi-row insert well under SQLite's bound-parameter limit. */
const HOUR_INSERT_CHUNK = 200;

/**
 * Keys a pulled history's sources to its lease. Every box is cloned from one
 * template, so a box's own fingerprint cannot tell boxes apart; the lease id can.
 */
export function leaseOwnedUsage(leaseId: string, usage: BoxUsage): BoxUsage {
  return {
    sources: usage.sources.map((source) => ({
      ...source,
      fingerprint: { ...source.fingerprint, hostId: leaseId },
    })),
    buckets: usage.buckets,
  };
}

export class BoxUsageStore extends Context.Service<
  BoxUsageStore,
  {
    /** Replaces the lease's stored history. History with no hour buckets deletes it. */
    readonly replace: (input: {
      readonly leaseId: string;
      readonly accountIds: ReadonlyArray<string>;
      readonly usage: BoxUsage;
      readonly pulledAt: string;
    }) => Effect.Effect<void, BoxUsageStoreError>;
    /**
     * Hours in `[sinceIso, untilIso)`, grouped by lease with the lease's sources.
     * A lease counts as retired when its row is gone, or it has not been
     * active since before `retiredBeforeIso`.
     */
    readonly list: (
      sinceIso: string,
      untilIso: string,
      retiredBeforeIso: string,
    ) => Effect.Effect<ReadonlyArray<StoredBoxUsage>, BoxUsageStoreError>;
    /** Deletes hours before `cutoffIso`, then leases with no hours left. */
    readonly prune: (cutoffIso: string) => Effect.Effect<void, BoxUsageStoreError>;
  }
>()("t3/usage/boxUsage/BoxUsageStore") {
  static readonly layer = Layer.effect(
    BoxUsageStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const replace = Effect.fn("BoxUsageStore.replace")(
        function* (input: {
          readonly leaseId: string;
          readonly accountIds: ReadonlyArray<string>;
          readonly usage: BoxUsage;
          readonly pulledAt: string;
        }) {
          const hours = input.usage.buckets.flatMap((bucket) =>
            bucket.hourStart === undefined
              ? []
              : [
                  {
                    lease_id: input.leaseId,
                    hour_start: bucket.hourStart,
                    bucket_json: encodeBucket(bucket),
                  },
                ],
          );
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM box_usage_hours WHERE lease_id = ${input.leaseId}`;
              if (hours.length === 0) {
                yield* sql`DELETE FROM box_usage WHERE lease_id = ${input.leaseId}`;
                return;
              }
              for (let index = 0; index < hours.length; index += HOUR_INSERT_CHUNK) {
                yield* sql`INSERT INTO box_usage_hours ${sql.insert(
                  hours.slice(index, index + HOUR_INSERT_CHUNK),
                )}`;
              }
              yield* sql`
                INSERT INTO box_usage (lease_id, account_ids_json, sources_json, pulled_at)
                VALUES (${input.leaseId}, ${encodeAccountIds(input.accountIds)}, ${encodeSources(input.usage.sources)}, ${input.pulledAt})
                ON CONFLICT(lease_id) DO UPDATE SET
                  account_ids_json = excluded.account_ids_json,
                  sources_json = excluded.sources_json,
                  pulled_at = excluded.pulled_at
              `;
            }),
          );
        },
        Effect.mapError((cause) => new BoxUsageStoreError({ operation: "replace", cause })),
      );
      const list = Effect.fn("BoxUsageStore.list")(
        function* (sinceIso: string, untilIso: string, retiredBeforeIso: string) {
          const [leaseRows, hourRows] = yield* sql.withTransaction(
            Effect.all([
              sql`
                SELECT
                  box_usage.lease_id AS "leaseId",
                  box_usage.account_ids_json AS "accountIds",
                  box_usage.sources_json AS sources,
                  box_usage.pulled_at AS "pulledAt",
                  CASE
                    WHEN provisioned_leases.lease_id IS NULL THEN 1
                    WHEN json_extract(provisioned_leases.lease_json, '$.state') <> 'active'
                      AND json_extract(provisioned_leases.lease_json, '$.updatedAt') < ${retiredBeforeIso}
                      THEN 1
                    ELSE 0
                  END AS retired
                FROM box_usage
                LEFT JOIN provisioned_leases ON provisioned_leases.lease_id = box_usage.lease_id
                WHERE box_usage.lease_id IN (
                  SELECT lease_id FROM box_usage_hours
                  WHERE hour_start >= ${sinceIso} AND hour_start < ${untilIso}
                )
                ORDER BY box_usage.lease_id
              `,
              sql`
                SELECT lease_id AS "leaseId", bucket_json AS bucket
                FROM box_usage_hours
                WHERE hour_start >= ${sinceIso} AND hour_start < ${untilIso}
                ORDER BY hour_start
              `,
            ]),
          );
          // One unreadable row must not hide every other box's usage.
          const skip = (leaseId: unknown) => (error: Schema.SchemaError) =>
            Effect.logWarning("skipping unreadable cloud box usage", {
              leaseId,
              error: error.message,
            }).pipe(Effect.as(null));
          const buckets = new Map<string, UsageBucket[]>();
          for (const row of hourRows) {
            const hour = yield* decodeHourRow(row).pipe(Effect.catch(skip(row.leaseId)));
            if (hour === null) continue;
            const leaseBuckets = buckets.get(hour.leaseId) ?? [];
            leaseBuckets.push(hour.bucket);
            buckets.set(hour.leaseId, leaseBuckets);
          }
          const stored: StoredBoxUsage[] = [];
          for (const row of leaseRows) {
            const lease = yield* decodeLeaseRow(row).pipe(Effect.catch(skip(row.leaseId)));
            if (lease === null) continue;
            stored.push({
              ...lease,
              buckets: buckets.get(lease.leaseId) ?? [],
              retired: lease.retired === 1,
            });
          }
          return stored;
        },
        Effect.mapError((cause) => new BoxUsageStoreError({ operation: "list", cause })),
      );
      const prune = Effect.fn("BoxUsageStore.prune")(
        function* (cutoffIso: string) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM box_usage_hours WHERE hour_start < ${cutoffIso}`;
              yield* sql`
                DELETE FROM box_usage
                WHERE lease_id NOT IN (SELECT DISTINCT lease_id FROM box_usage_hours)
              `;
            }),
          );
        },
        Effect.mapError((cause) => new BoxUsageStoreError({ operation: "prune", cause })),
      );
      return { replace, list, prune };
    }),
  );
}

const sourceKey = (provider: UsageProviderKind, path: string) => `${provider}\u0000${path}`;

/**
 * What a box's history keeps for a host: Cursor is dropped because the host
 * reads the Cursor account itself, and missing or empty sources and buckets
 * without a kept source are dropped because the host has nothing to show for them.
 */
export function historyForHost(summary: UsageSummary): UsageSummary {
  const bucketSources = new Set(
    summary.buckets.flatMap((bucket) =>
      bucket.provider === "cursor" || bucket.sourcePath === undefined
        ? []
        : [sourceKey(bucket.provider, bucket.sourcePath)],
    ),
  );
  const sources = summary.sources.filter(
    (source) =>
      source.status !== "missing" &&
      bucketSources.has(sourceKey(source.fingerprint.provider, usageSourcePath(source))),
  );
  const kept = new Set(
    sources.map((source) => sourceKey(source.fingerprint.provider, usageSourcePath(source))),
  );
  return {
    ...summary,
    sources,
    buckets: summary.buckets.filter(
      (bucket) =>
        bucket.sourcePath !== undefined && kept.has(sourceKey(bucket.provider, bucket.sourcePath)),
    ),
  };
}

/**
 * The hours a stored row may need for `input`'s window, as `[since, until)`.
 * A day window widens by the zone slack; the fold then filters exactly.
 */
export function boxUsageListWindow(input: UsageSummaryInput): {
  readonly sinceIso: string;
  readonly untilIso: string;
} {
  const [sinceMs, untilMs] =
    input.resolution === "hour"
      ? [Date.parse(input.sinceTime ?? ""), Date.parse(input.untilTime ?? "")]
      : [
          Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS,
          Date.parse(`${input.untilDay}T00:00:00Z`) + 2 * DAY_MS,
        ];
  return Number.isNaN(sinceMs) || Number.isNaN(untilMs)
    ? { sinceIso: "", untilIso: "" }
    : { sinceIso: new Date(sinceMs).toISOString(), untilIso: new Date(untilMs).toISOString() };
}

function sumBuckets(a: UsageBucket, b: UsageBucket): UsageBucket {
  return {
    ...a,
    totals: addTotals(a.totals, b.totals),
    costUsd: a.costUsd + b.costUsd,
    cacheSavingsUsd: a.cacheSavingsUsd + b.cacheSavingsUsd,
    // Mixed provenance reads as model-priced, as a scanned bucket would.
    costSource: a.costSource === b.costSource ? a.costSource : "modelPriced",
    records: a.records + b.records,
    unpricedRecords: a.unpricedRecords + b.unpricedRecords,
    // Hours of one session would count it once per hour, so the larger count
    // is the honest lower bound.
    sessions: Math.max(a.sessions, b.sessions),
  };
}

/**
 * Folds stored box history into a host summary for `input`'s window.
 *
 * A live box keeps its own fingerprint so a client that also reaches the box
 * counts it once, with a per-box `sourcePath` so boxes sharing a home path stay
 * apart. Retired boxes collapse into one source per provider at `retiredHome`,
 * so the summary does not grow with every box the host ever ran.
 */
export function foldBoxUsage(
  summary: UsageSummary,
  input: UsageSummaryInput,
  rows: ReadonlyArray<StoredBoxUsage>,
  retiredHome: { readonly hostId: string; readonly path: string },
): UsageSummary {
  if (rows.length === 0) return summary;
  const toDay = makeDayFormatter(input.timeZone);
  const hourly = input.resolution === "hour";
  const sinceMs = Date.parse(input.sinceTime ?? "");
  const untilMs = Date.parse(input.untilTime ?? "");
  const cells = new Map<string, UsageBucket>();
  const liveSources: UsageSource[] = [];
  const retiredSources = new Map<UsageProviderKind, UsageSource>();

  for (const row of rows) {
    const stored = new Set(
      row.sources.map((source) => sourceKey(source.fingerprint.provider, usageSourcePath(source))),
    );
    const sessionsBySource = new Map<string, number>();
    for (const bucket of row.buckets) {
      if (bucket.hourStart === undefined || bucket.sourcePath === undefined) continue;
      const key = sourceKey(bucket.provider, bucket.sourcePath);
      if (!stored.has(key)) continue;
      const hourMs = Date.parse(bucket.hourStart);
      if (Number.isNaN(hourMs)) continue;
      if (hourly && !(hourMs >= sinceMs && hourMs < untilMs)) continue;
      const day = toDay(hourMs) as UsageBucket["day"];
      if (!hourly && (day < input.sinceDay || day > input.untilDay)) continue;
      const sourcePath = row.retired ? retiredHome.path : `${row.leaseId}:${bucket.sourcePath}`;
      const cell: UsageBucket = {
        day,
        ...(hourly ? { hourStart: bucket.hourStart } : {}),
        provider: bucket.provider,
        model: bucket.model,
        sourcePath,
        totals: bucket.totals,
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        costSource: bucket.costSource,
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions,
      };
      const cellKey = [day, cell.hourStart ?? "", cell.provider, cell.model, sourcePath].join(
        "\u0000",
      );
      const existing = cells.get(cellKey);
      cells.set(cellKey, existing === undefined ? cell : sumBuckets(existing, cell));
      sessionsBySource.set(key, (sessionsBySource.get(key) ?? 0) + bucket.sessions);
    }

    for (const source of row.sources) {
      const path = usageSourcePath(source);
      const bucketSessions = sessionsBySource.get(sourceKey(source.fingerprint.provider, path));
      if (bucketSessions === undefined) continue;
      const distinctSessions = Math.min(source.distinctSessions, bucketSessions);
      if (!row.retired) {
        // Partial, so a complete live scan of the same box claims its
        // fingerprint and this copy only fills cells the live scan lacks.
        liveSources.push({
          ...source,
          status: "partial",
          sourcePath: `${row.leaseId}:${path}`,
          distinctSessions,
        });
        continue;
      }
      const provider = source.fingerprint.provider;
      const retired = retiredSources.get(provider);
      retiredSources.set(provider, {
        fingerprint: {
          hostId: retiredHome.hostId,
          provider,
          resolvedHomePath: retiredHome.path,
          volumeId: "",
        },
        status: "ok",
        scannedFiles: (retired?.scannedFiles ?? 0) + source.scannedFiles,
        skippedFiles: (retired?.skippedFiles ?? 0) + source.skippedFiles,
        malformedRecords: (retired?.malformedRecords ?? 0) + source.malformedRecords,
        distinctSessions: (retired?.distinctSessions ?? 0) + distinctSessions,
        message: null,
      });
    }
  }

  return {
    ...summary,
    buckets: [...summary.buckets, ...cells.values()].sort(compareUsageBuckets),
    sources: [...summary.sources, ...liveSources, ...retiredSources.values()],
  };
}
