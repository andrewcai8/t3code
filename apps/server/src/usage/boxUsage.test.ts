import { assert, describe, it } from "@effect/vitest";
import {
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createProvisionedLeaseRegistry } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { BoxUsageStore, foldBoxUsage, type StoredBoxUsage } from "./boxUsage.ts";

const BOX_HOME = "/home/user/.claude/projects";

const tokens = (uncachedInputTokens: number) => ({
  uncachedInputTokens,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

function hourBucket(
  hourStart: string,
  inputTokens: number,
  overrides: Partial<UsageBucket> = {},
): UsageBucket {
  return {
    day: UsageDay.make(hourStart.slice(0, 10)),
    hourStart,
    provider: "claude",
    model: "claude-fable-5",
    sourcePath: BOX_HOME,
    totals: tokens(inputTokens),
    costUsd: inputTokens,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function boxSource(hostId: string, distinctSessions = 1): UsageSource {
  return {
    fingerprint: { hostId, provider: "claude", resolvedHomePath: BOX_HOME, volumeId: "2049:7" },
    status: "ok",
    scannedFiles: 2,
    skippedFiles: 1,
    malformedRecords: 0,
    distinctSessions,
    message: null,
  };
}

const inStore = <A, E>(body: (store: BoxUsageStore["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    yield* runMigrations();
    return yield* body(yield* BoxUsageStore);
  }).pipe(
    Effect.provide(
      BoxUsageStore.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );

const totalTokens = (rows: ReadonlyArray<StoredBoxUsage>) =>
  rows
    .flatMap((row) => row.usage.buckets)
    .reduce((sum, b) => sum + b.totals.uncachedInputTokens, 0);

describe("BoxUsageStore", () => {
  it.effect("replaces a lease's history rather than adding to it", () =>
    inStore((store) =>
      Effect.gen(function* () {
        yield* store.replace({
          leaseId: "lease-a",
          accountIds: ["claude"],
          usage: {
            sources: [boxSource("box-a")],
            buckets: [hourBucket("2026-09-01T03:00:00.000Z", 40)],
          },
          pulledAt: "2026-09-01T04:00:00.000Z",
        });
        yield* store.replace({
          leaseId: "lease-a",
          accountIds: ["claude", "codex"],
          usage: {
            sources: [boxSource("box-a")],
            buckets: [
              hourBucket("2026-09-01T03:00:00.000Z", 40),
              hourBucket("2026-09-01T05:00:00.000Z", 60),
            ],
          },
          pulledAt: "2026-09-01T06:00:00.000Z",
        });
        const rows = yield* store.list("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
        assert.deepStrictEqual(
          rows.map((row) => [row.leaseId, row.accountIds, row.latestHourStart, row.pulledAt]),
          [
            [
              "lease-a",
              ["claude", "codex"],
              "2026-09-01T05:00:00.000Z",
              "2026-09-01T06:00:00.000Z",
            ],
          ],
        );
        assert.strictEqual(totalTokens(rows), 100);

        yield* store.replace({
          leaseId: "lease-a",
          accountIds: ["claude"],
          usage: { sources: [], buckets: [] },
          pulledAt: "2026-09-01T07:00:00.000Z",
        });
        assert.deepStrictEqual(
          yield* store.list("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
          [],
        );
      }),
    ),
  );

  it.effect("prunes rows whose newest usage is before the cutoff", () =>
    inStore((store) =>
      Effect.gen(function* () {
        for (const [leaseId, hourStart] of [
          ["lease-old", "2026-06-01T10:00:00.000Z"],
          ["lease-new", "2026-09-01T10:00:00.000Z"],
        ] as const) {
          yield* store.replace({
            leaseId,
            accountIds: ["claude"],
            usage: { sources: [boxSource(leaseId)], buckets: [hourBucket(hourStart, 1)] },
            pulledAt: hourStart,
          });
        }
        yield* store.prune("2026-06-29T00:00:00.000Z");
        const rows = yield* store.list("", "");
        assert.deepStrictEqual(
          rows.map((row) => row.leaseId),
          ["lease-new"],
        );
      }),
    ),
  );

  it.effect("retires a box only once its lease has been gone for a day", () =>
    inStore((store) =>
      Effect.gen(function* () {
        const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
        const created = new Date("2026-09-01T00:00:00.000Z");
        for (const [leaseId, disposedAt] of [
          ["lease-disposed-long-ago", "2026-09-02T00:00:00.000Z"],
          ["lease-disposed-recently", "2026-09-03T23:00:00.000Z"],
          ["lease-running", null],
        ] as const) {
          yield* Effect.promise(async () => {
            await registry.register({
              leaseId,
              sandboxId: `${leaseId}-sandbox`,
              providerInstanceId: "claude",
              now: created,
            });
            if (disposedAt) await registry.markDisposed(leaseId, new Date(disposedAt));
          });
        }
        for (const leaseId of [
          "lease-disposed-long-ago",
          "lease-disposed-recently",
          "lease-running",
          "lease-unknown",
        ]) {
          yield* store.replace({
            leaseId,
            accountIds: ["claude"],
            usage: {
              sources: [boxSource(leaseId)],
              buckets: [hourBucket("2026-09-01T10:00:00.000Z", 1)],
            },
            pulledAt: "2026-09-01T11:00:00.000Z",
          });
        }
        const rows = yield* store.list("2026-09-01T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
        assert.deepStrictEqual(
          rows.map((row) => [row.leaseId, row.retired]),
          [
            ["lease-disposed-long-ago", true],
            ["lease-disposed-recently", false],
            ["lease-running", false],
            ["lease-unknown", true],
          ],
        );
      }),
    ),
  );
});

describe("foldBoxUsage", () => {
  const hostSummary: UsageSummary = {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-09-02T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-01"),
    untilDay: UsageDay.make("2026-09-01"),
    buckets: [],
    sources: [],
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 0,
  };
  const row = (leaseId: string, retired: boolean, buckets: UsageBucket[], sessions = 1) => ({
    leaseId,
    accountIds: ["claude"],
    usage: { sources: [boxSource(`host-${leaseId}`, sessions)], buckets },
    latestHourStart: buckets.at(-1)?.hourStart ?? "",
    pulledAt: "2026-09-02T00:00:00.000Z",
    retired,
  });

  it("collapses retired boxes into one source per provider and keeps a live box apart", () => {
    const folded = foldBoxUsage(
      hostSummary,
      { timeZone: "UTC", sinceDay: hostSummary.sinceDay, untilDay: hostSummary.untilDay },
      [
        row(
          "lease-r1",
          true,
          [
            hourBucket("2026-09-01T03:00:00.000Z", 10, { sessions: 2 }),
            hourBucket("2026-09-01T04:00:00.000Z", 20, { costSource: "providerReported" }),
          ],
          3,
        ),
        row("lease-r2", true, [hourBucket("2026-09-01T03:00:00.000Z", 100)]),
        row("lease-live", false, [
          hourBucket("2026-09-01T03:00:00.000Z", 1000),
          hourBucket("2026-09-02T03:00:00.000Z", 5000),
        ]),
      ],
      { hostId: "host", path: "/state/cloud-box-usage" },
    );

    assert.deepStrictEqual(
      folded.buckets.map((bucket) => [
        bucket.day,
        bucket.hourStart,
        bucket.sourcePath,
        bucket.totals.uncachedInputTokens,
        bucket.costUsd,
        bucket.costSource,
        bucket.records,
        bucket.sessions,
      ]),
      [
        ["2026-09-01", undefined, "/state/cloud-box-usage", 130, 130, "modelPriced", 3, 2],
        ["2026-09-01", undefined, `lease-live:${BOX_HOME}`, 1000, 1000, "modelPriced", 1, 1],
      ],
    );
    assert.deepStrictEqual(
      folded.sources.map((source) => [
        source.fingerprint.hostId,
        source.fingerprint.resolvedHomePath,
        source.sourcePath,
        source.scannedFiles,
        source.distinctSessions,
      ]),
      [
        ["host-lease-live", BOX_HOME, `lease-live:${BOX_HOME}`, 2, 1],
        ["host", "/state/cloud-box-usage", undefined, 4, 4],
      ],
    );
  });

  it("keeps hour buckets in an hourly window", () => {
    const folded = foldBoxUsage(
      hostSummary,
      {
        timeZone: "America/Los_Angeles",
        sinceDay: UsageDay.make("2026-08-31"),
        untilDay: UsageDay.make("2026-09-01"),
        resolution: "hour",
        sinceTime: "2026-09-01T03:00:00.000Z",
        untilTime: "2026-09-01T05:00:00.000Z",
      },
      [
        row("lease-live", false, [
          hourBucket("2026-09-01T02:00:00.000Z", 1),
          hourBucket("2026-09-01T03:00:00.000Z", 10),
          hourBucket("2026-09-01T04:00:00.000Z", 100),
          hourBucket("2026-09-01T05:00:00.000Z", 1000),
        ]),
      ],
      { hostId: "host", path: "/state/cloud-box-usage" },
    );

    assert.deepStrictEqual(
      folded.buckets.map((bucket) => [
        bucket.day,
        bucket.hourStart,
        bucket.totals.uncachedInputTokens,
      ]),
      [
        ["2026-08-31", "2026-09-01T03:00:00.000Z", 10],
        ["2026-08-31", "2026-09-01T04:00:00.000Z", 100],
      ],
    );
  });
});
