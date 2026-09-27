// @effect-diagnostics globalDate:off - stored hour buckets are re-bucketed by ISO instant.
/**
 * Usage a host keeps for its cloud boxes.
 *
 * Cloud chats write transcripts on an ephemeral box, so the host pulls each
 * box's hourly UTC history, stores one row per lease, and folds the rows into
 * its own summary. Hour buckets re-bucket exactly into any client's day or
 * hour window.
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
const BoxUsage = Schema.Struct({
  sources: ForwardCompatibleArray(UsageSource),
  buckets: ForwardCompatibleArray(UsageBucket),
});
export type BoxUsage = typeof BoxUsage.Type;

export interface StoredBoxUsage {
  readonly leaseId: string;
  readonly accountIds: ReadonlyArray<string>;
  readonly usage: BoxUsage;
  readonly latestHourStart: string;
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

const encodeBoxUsage = Schema.encodeSync(Schema.fromJsonString(BoxUsage));
const encodeAccountIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeRow = Schema.decodeUnknownEffect(
  Schema.Struct({
    leaseId: Schema.String,
    accountIds: Schema.fromJsonString(Schema.Array(Schema.String)),
    usage: Schema.fromJsonString(BoxUsage),
    latestHourStart: Schema.String,
    pulledAt: Schema.String,
    retired: Schema.Number,
  }),
);

export class BoxUsageStore extends Context.Service<
  BoxUsageStore,
  {
    /** Replaces the lease's stored history. History with no buckets deletes it. */
    readonly replace: (input: {
      readonly leaseId: string;
      readonly accountIds: ReadonlyArray<string>;
      readonly usage: BoxUsage;
      readonly pulledAt: string;
    }) => Effect.Effect<void, BoxUsageStoreError>;
    /**
     * Rows with usage at or after `sinceIso`. A row counts as retired when its
     * lease is gone, or was disposed or went missing before `retiredBeforeIso`.
     */
    readonly list: (
      sinceIso: string,
      retiredBeforeIso: string,
    ) => Effect.Effect<ReadonlyArray<StoredBoxUsage>, BoxUsageStoreError>;
    /** Deletes rows whose newest usage is before `cutoffIso`. */
    readonly prune: (cutoffIso: string) => Effect.Effect<void, BoxUsageStoreError>;
  }
>()("t3/usage/BoxUsageStore") {
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
          let latestHourStart: string | null = null;
          for (const bucket of input.usage.buckets) {
            if (
              bucket.hourStart !== undefined &&
              (latestHourStart === null || bucket.hourStart > latestHourStart)
            )
              latestHourStart = bucket.hourStart;
          }
          if (latestHourStart === null) {
            yield* sql`DELETE FROM box_usage WHERE lease_id = ${input.leaseId}`;
            return;
          }
          const usage = encodeBoxUsage({
            sources: input.usage.sources,
            buckets: input.usage.buckets,
          });
          yield* sql`
            INSERT INTO box_usage (lease_id, account_ids_json, usage_json, latest_hour_start, pulled_at)
            VALUES (${input.leaseId}, ${encodeAccountIds(input.accountIds)}, ${usage}, ${latestHourStart}, ${input.pulledAt})
            ON CONFLICT(lease_id) DO UPDATE SET
              account_ids_json = excluded.account_ids_json,
              usage_json = excluded.usage_json,
              latest_hour_start = excluded.latest_hour_start,
              pulled_at = excluded.pulled_at
          `;
        },
        Effect.mapError((cause) => new BoxUsageStoreError({ operation: "replace", cause })),
      );
      const list = Effect.fn("BoxUsageStore.list")(
        function* (sinceIso: string, retiredBeforeIso: string) {
          const rows = yield* sql`
            SELECT
              box_usage.lease_id AS "leaseId",
              box_usage.account_ids_json AS "accountIds",
              box_usage.usage_json AS usage,
              box_usage.latest_hour_start AS "latestHourStart",
              box_usage.pulled_at AS "pulledAt",
              CASE
                WHEN provisioned_leases.lease_id IS NULL THEN 1
                WHEN json_extract(provisioned_leases.lease_json, '$.state') IN ('disposed', 'missing')
                  AND json_extract(provisioned_leases.lease_json, '$.updatedAt') < ${retiredBeforeIso}
                  THEN 1
                ELSE 0
              END AS retired
            FROM box_usage
            LEFT JOIN provisioned_leases ON provisioned_leases.lease_id = box_usage.lease_id
            WHERE box_usage.latest_hour_start >= ${sinceIso}
            ORDER BY box_usage.lease_id
          `;
          const stored = yield* Effect.forEach(rows, (row) =>
            decodeRow(row).pipe(
              Effect.map((decoded): StoredBoxUsage | null => ({
                ...decoded,
                retired: decoded.retired === 1,
              })),
              // One unreadable row must not hide every other box's usage.
              Effect.catch((error) =>
                Effect.logWarning("skipping unreadable cloud box usage", {
                  leaseId: row.leaseId,
                  error: error.message,
                }).pipe(Effect.as(null)),
              ),
            ),
          );
          return stored.filter((row) => row !== null);
        },
        Effect.mapError((cause) => new BoxUsageStoreError({ operation: "list", cause })),
      );
      const prune = Effect.fn("BoxUsageStore.prune")(
        function* (cutoffIso: string) {
          yield* sql`DELETE FROM box_usage WHERE latest_hour_start < ${cutoffIso}`;
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
 * The earliest `latest_hour_start` a stored row may have and still land in
 * the window. A day window starts a day early because days are in the
 * client's zone.
 */
export function boxUsageListSince(input: UsageSummaryInput): string {
  const sinceMs =
    input.resolution === "hour"
      ? Date.parse(input.sinceTime ?? "")
      : Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS;
  return Number.isNaN(sinceMs) ? "" : new Date(sinceMs).toISOString();
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
      row.usage.sources.map((source) =>
        sourceKey(source.fingerprint.provider, usageSourcePath(source)),
      ),
    );
    const sessionsBySource = new Map<string, number>();
    for (const bucket of row.usage.buckets) {
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

    for (const source of row.usage.sources) {
      const path = usageSourcePath(source);
      const bucketSessions = sessionsBySource.get(sourceKey(source.fingerprint.provider, path));
      if (bucketSessions === undefined) continue;
      const distinctSessions = Math.min(source.distinctSessions, bucketSessions);
      if (!row.retired) {
        liveSources.push({ ...source, sourcePath: `${row.leaseId}:${path}`, distinctSessions });
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
