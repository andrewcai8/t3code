// @effect-diagnostics globalDateInEffect:off - lease fixtures use fixed timestamps.
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  type UsageBucket,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createProvisionedLeaseRegistry } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  BoxUsageStore,
  boxUsageListWindow,
  foldBoxUsage,
  importMachineUsage,
  leaseOwnedUsage,
  type StoredBoxUsage,
} from "./boxUsage.ts";

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

const inStore = <A, E>(
  body: (store: BoxUsageStore["Service"]) => Effect.Effect<A, E, SqlClient.SqlClient>,
) =>
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

function summaryOf(
  buckets: ReadonlyArray<UsageBucket>,
  sources: ReadonlyArray<UsageSource>,
  readAt: string,
): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt,
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-01"),
    untilDay: UsageDay.make("2026-09-01"),
    buckets,
    sources,
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 0,
  };
}

/** Every stored hour, with no box retired. */
const ALL_HOURS = ["", "9999", ""] as const;

const tokensIn = (rows: ReadonlyArray<StoredBoxUsage>) =>
  rows.flatMap((row) => row.buckets).reduce((sum, b) => sum + b.totals.uncachedInputTokens, 0);

const storedLeases = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly leaseId: string }>`
    SELECT lease_id AS "leaseId" FROM box_usage ORDER BY lease_id
  `;
  return rows.map((row) => row.leaseId);
});

describe("BoxUsageStore", () => {
  it.effect("replaces a lease's history rather than adding to it", () =>
    inStore((store) =>
      Effect.gen(function* () {
        yield* store.replace({
          leaseId: "lease-a",
          origin: "box",
          accountIds: ["claude"],
          usage: {
            sources: [boxSource("box-a")],
            buckets: [hourBucket("2026-09-01T03:00:00.000Z", 40)],
          },
          pulledAt: "2026-09-01T04:00:00.000Z",
        });
        yield* store.replace({
          leaseId: "lease-a",
          origin: "box",
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
        const rows = yield* store.list(...ALL_HOURS);
        assert.deepStrictEqual(
          rows.map((row) => [row.leaseId, row.accountIds, row.pulledAt, row.buckets.length]),
          [["lease-a", ["claude", "codex"], "2026-09-01T06:00:00.000Z", 2]],
        );
        assert.strictEqual(tokensIn(rows), 100);

        yield* store.replace({
          leaseId: "lease-a",
          origin: "box",
          accountIds: ["claude"],
          usage: { sources: [], buckets: [] },
          pulledAt: "2026-09-01T07:00:00.000Z",
        });
        assert.deepStrictEqual(yield* store.list(...ALL_HOURS), []);
        assert.deepStrictEqual(yield* storedLeases, []);
      }),
    ),
  );

  it.effect("reads only the hours inside the window", () =>
    inStore((store) =>
      Effect.gen(function* () {
        yield* store.replace({
          leaseId: "lease-a",
          origin: "box",
          accountIds: ["claude"],
          usage: {
            sources: [boxSource("box-a")],
            buckets: [
              hourBucket("2026-09-01T02:00:00.000Z", 1),
              hourBucket("2026-09-01T03:00:00.000Z", 10),
              hourBucket("2026-09-01T04:00:00.000Z", 100),
            ],
          },
          pulledAt: "2026-09-01T05:00:00.000Z",
        });
        const rows = yield* store.list("2026-09-01T03:00:00.000Z", "2026-09-01T04:00:00.000Z", "");
        assert.deepStrictEqual(
          rows.map((row) => [row.leaseId, row.buckets.map((bucket) => bucket.hourStart)]),
          [["lease-a", ["2026-09-01T03:00:00.000Z"]]],
        );
      }),
    ),
  );

  it.effect("prunes hours before the cutoff and leases left without hours", () =>
    inStore((store) =>
      Effect.gen(function* () {
        for (const [leaseId, hourStarts] of [
          ["lease-old", ["2026-06-01T10:00:00.000Z"]],
          ["lease-mixed", ["2026-06-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z"]],
          ["lease-new", ["2026-09-01T10:00:00.000Z"]],
        ] as const) {
          yield* store.replace({
            leaseId,
            origin: "box",
            accountIds: ["claude"],
            usage: {
              sources: [boxSource(leaseId)],
              buckets: hourStarts.map((hourStart) => hourBucket(hourStart, 1)),
            },
            pulledAt: "2026-09-01T11:00:00.000Z",
          });
        }
        yield* store.prune("2026-06-29T00:00:00.000Z");
        const rows = yield* store.list(...ALL_HOURS);
        assert.deepStrictEqual(
          rows.map((row) => [row.leaseId, row.buckets.map((bucket) => bucket.hourStart)]),
          [
            ["lease-mixed", ["2026-09-01T10:00:00.000Z"]],
            ["lease-new", ["2026-09-01T10:00:00.000Z"]],
          ],
        );
        assert.deepStrictEqual(yield* storedLeases, ["lease-mixed", "lease-new"]);
      }),
    ),
  );

  it.effect("retires a box once its lease has not been active for a day", () =>
    inStore((store) =>
      Effect.gen(function* () {
        const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
        const leases = [
          { leaseId: "lease-disposed-long-ago", settled: ["disposed", "2026-09-02T00:00:00.000Z"] },
          { leaseId: "lease-disposed-recently", settled: ["disposed", "2026-09-03T23:00:00.000Z"] },
          { leaseId: "lease-paused-long-ago", settled: ["paused", "2026-09-02T00:00:00.000Z"] },
          { leaseId: "lease-active-quiet", settled: null },
        ] as const;
        for (const { leaseId, settled } of leases) {
          yield* Effect.promise(async () => {
            await registry.register({
              leaseId,
              sandboxId: `${leaseId}-sandbox`,
              providerInstanceId: "claude",
              now: new Date("2026-09-02T00:00:00.000Z"),
            });
            if (settled?.[0] === "disposed")
              await registry.markDisposed(leaseId, new Date(settled[1]));
            if (settled?.[0] === "paused") await registry.markPaused(leaseId, new Date(settled[1]));
          });
        }
        for (const leaseId of [
          "lease-active-quiet",
          "lease-disposed-long-ago",
          "lease-disposed-recently",
          "lease-paused-long-ago",
          "lease-unknown",
        ]) {
          yield* store.replace({
            leaseId,
            origin: "box",
            accountIds: ["claude"],
            usage: {
              sources: [boxSource(leaseId)],
              buckets: [hourBucket("2026-09-01T10:00:00.000Z", 1)],
            },
            pulledAt: "2026-09-01T11:00:00.000Z",
          });
        }
        const rows = yield* store.list(
          "2026-09-01T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
          "2026-09-03T00:00:00.000Z",
        );
        assert.deepStrictEqual(
          rows.map((row) => [row.leaseId, row.retired]),
          [
            ["lease-active-quiet", false],
            ["lease-disposed-long-ago", true],
            ["lease-disposed-recently", false],
            ["lease-paused-long-ago", true],
            ["lease-unknown", true],
          ],
        );
      }),
    ),
  );

  it.effect(
    "counts boxes cloned from one template apart, and a live box over its stored copy",
    () =>
      inStore((store) =>
        Effect.gen(function* () {
          const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
          const template = boxSource("e2b.local");
          for (const [leaseId, inputTokens] of [
            ["lease-a", 10],
            ["lease-b", 20],
          ] as const) {
            yield* Effect.promise(() =>
              registry.register({
                leaseId,
                sandboxId: `${leaseId}-sandbox`,
                providerInstanceId: "claude",
              }),
            );
            yield* store.replace({
              leaseId,
              origin: "box",
              accountIds: ["claude"],
              usage: leaseOwnedUsage(leaseId, {
                sources: [template],
                buckets: [hourBucket("2026-09-01T03:00:00.000Z", inputTokens)],
              }),
              pulledAt: "2026-09-01T04:00:00.000Z",
            });
          }
          const input = {
            timeZone: "UTC",
            sinceDay: UsageDay.make("2026-09-01"),
            untilDay: UsageDay.make("2026-09-01"),
          };
          const window = boxUsageListWindow(input);
          const host = foldBoxUsage(
            summaryOf([], [], "2026-09-01T04:00:00.000Z"),
            input,
            yield* store.list(window.sinceIso, window.untilIso, "2026-08-31T00:00:00.000Z"),
            { hostId: "host", path: "/state/cloud-box-usage" },
          );
          const liveA = summaryOf(
            [{ ...hourBucket("2026-09-01T03:00:00.000Z", 11), hourStart: undefined }],
            [boxSource("lease-a")],
            "2026-09-01T05:00:00.000Z",
          );
          const merged = mergeUsage(
            [
              { environmentId: EnvironmentId.make("host"), label: "host", summary: host },
              { environmentId: EnvironmentId.make("box-a"), label: "box-a", summary: liveA },
            ],
            USAGE_CONTRACT_VERSION,
          );
          assert.strictEqual(merged.totalTokens, 31);
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
  const row = (
    leaseId: string,
    retired: boolean,
    buckets: UsageBucket[],
    sessions = 1,
  ): StoredBoxUsage => ({
    leaseId,
    accountIds: ["claude"],
    sources: [boxSource(`host-${leaseId}`, sessions)],
    buckets,
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
        source.status,
        source.fingerprint.resolvedHomePath,
        source.sourcePath,
        source.scannedFiles,
        source.distinctSessions,
      ]),
      [
        ["host-lease-live", "partial", BOX_HOME, `lease-live:${BOX_HOME}`, 2, 1],
        ["host", "ok", "/state/cloud-box-usage", undefined, 4, 4],
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

describe("importMachineUsage", () => {
  const MAC_HOME = "/Users/me/.claude/projects";
  const MAC_CODEX = "/Users/me/.codex/sessions";
  const DAY = {
    timeZone: "UTC",
    sinceDay: UsageDay.make("2026-09-01"),
    untilDay: UsageDay.make("2026-09-01"),
  };
  const macSource = (
    provider: UsageSource["fingerprint"]["provider"],
    resolvedHomePath: string,
  ): UsageSource => ({
    fingerprint: {
      hostId: "Andrews-Mac.local",
      provider,
      resolvedHomePath,
      volumeId: "16777234:9",
    },
    status: "ok",
    scannedFiles: 3,
    skippedFiles: 0,
    malformedRecords: 0,
    distinctSessions: 2,
    message: null,
  });
  const macHistory = (claudeHours: ReadonlyArray<readonly [string, number]>) =>
    summaryOf(
      [
        ...claudeHours.map(([hourStart, input]) =>
          hourBucket(hourStart, input, { sourcePath: MAC_HOME }),
        ),
        hourBucket("2026-09-01T06:00:00.000Z", 7, { provider: "codex", sourcePath: MAC_CODEX }),
        hourBucket("2026-09-01T06:00:00.000Z", 1000, {
          provider: "cursor",
          sourcePath: "cursor-account:acct",
        }),
      ],
      [
        macSource("claude", MAC_HOME),
        macSource("codex", MAC_CODEX),
        {
          ...macSource("cursor", "cursor-account:acct"),
          fingerprint: {
            hostId: "cursor.com",
            provider: "cursor",
            resolvedHomePath: "cursor-account:acct",
            volumeId: "acct",
          },
        },
      ],
      "2026-09-01T07:00:00.000Z",
    );
  /** The host's summary for the day once it folds what it keeps. */
  const hostSummary = (store: BoxUsageStore["Service"], readAt: string) =>
    Effect.gen(function* () {
      const list = boxUsageListWindow(DAY);
      return foldBoxUsage(
        summaryOf([], [], readAt),
        DAY,
        yield* store.list(list.sinceIso, list.untilIso, "2026-08-31T00:00:00.000Z"),
        { hostId: "host", path: "/state/cloud-box-usage" },
      );
    });
  const merge = (...summaries: ReadonlyArray<readonly [string, UsageSummary]>) =>
    mergeUsage(
      summaries.map(([id, summary]) => ({
        environmentId: EnvironmentId.make(id),
        label: id,
        summary,
      })),
      USAGE_CONTRACT_VERSION,
    );

  it.effect("serves an import in the host's summary and replaces it on re-import", () =>
    inStore((store) =>
      Effect.gen(function* () {
        const first = yield* importMachineUsage(store, {
          machineId: "mac-environment",
          history: macHistory([["2026-09-01T03:00:00.000Z", 40]]),
        });
        assert.deepStrictEqual(first, { sources: 2, buckets: 2 });
        const afterFirst = merge(["host", yield* hostSummary(store, "2026-09-01T08:00:00.000Z")]);
        assert.deepStrictEqual(
          afterFirst.providers.map((provider) => [provider.provider, provider.totalTokens]),
          [
            ["claude", 40],
            ["codex", 7],
          ],
        );

        const history = macHistory([
          ["2026-09-01T03:00:00.000Z", 45],
          ["2026-09-01T05:00:00.000Z", 60],
        ]);
        yield* importMachineUsage(store, { machineId: "mac-environment", history });
        yield* importMachineUsage(store, { machineId: "mac-environment", history });
        const host = yield* hostSummary(store, "2026-09-01T08:00:00.000Z");
        assert.strictEqual(merge(["host", host]).totalTokens, 112);
        assert.deepStrictEqual(
          host.sources.map((source) => [
            source.fingerprint.hostId,
            source.fingerprint.resolvedHomePath,
            source.status,
            source.sourcePath,
          ]),
          [
            ["Andrews-Mac.local", MAC_HOME, "partial", `mac-environment:${MAC_HOME}`],
            ["Andrews-Mac.local", MAC_CODEX, "partial", `mac-environment:${MAC_CODEX}`],
          ],
        );
      }),
    ),
  );

  it.effect("counts the machine once when a client also connects to it", () =>
    inStore((store) =>
      Effect.gen(function* () {
        yield* importMachineUsage(store, {
          machineId: "mac-environment",
          history: macHistory([["2026-09-01T03:00:00.000Z", 40]]),
        });
        // A daily scan by the machine itself, which has seen 10 tokens since the import.
        const live = summaryOf(
          [
            hourBucket("2026-09-01T03:00:00.000Z", 50, {
              hourStart: undefined,
              sourcePath: MAC_HOME,
            }),
            hourBucket("2026-09-01T06:00:00.000Z", 7, {
              hourStart: undefined,
              provider: "codex",
              sourcePath: MAC_CODEX,
            }),
          ],
          [macSource("claude", MAC_HOME), macSource("codex", MAC_CODEX)],
          "2026-09-01T08:00:00.000Z",
        );
        for (const hostReadAt of ["2026-09-01T07:30:00.000Z", "2026-09-01T09:00:00.000Z"]) {
          const merged = merge(["host", yield* hostSummary(store, hostReadAt)], ["mac", live]);
          assert.deepStrictEqual(
            [merged.totalTokens, merged.contributingEnvironments],
            [57, [EnvironmentId.make("mac")]],
          );
        }
      }),
    ),
  );

  it.effect("keeps a machine apart from the host's cloud boxes", () =>
    inStore((store) =>
      Effect.gen(function* () {
        const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
        yield* Effect.promise(() =>
          registry.register({
            leaseId: "lease-live",
            sandboxId: "sandbox-live",
            providerInstanceId: "claude",
          }),
        );
        for (const leaseId of ["lease-live", "lease-gone"]) {
          yield* store.replace({
            leaseId,
            origin: "box",
            accountIds: ["claude"],
            usage: leaseOwnedUsage(leaseId, {
              sources: [boxSource("e2b.local")],
              buckets: [hourBucket("2026-09-01T03:00:00.000Z", 100)],
            }),
            pulledAt: "2026-09-01T04:00:00.000Z",
          });
        }
        yield* importMachineUsage(store, {
          machineId: "mac-environment",
          history: macHistory([["2026-09-01T03:00:00.000Z", 40]]),
        });
        const host = yield* hostSummary(store, "2026-09-01T08:00:00.000Z");
        assert.deepStrictEqual(
          host.sources.map((source) => [source.fingerprint.hostId, source.status]),
          [
            ["lease-live", "partial"],
            ["Andrews-Mac.local", "partial"],
            ["Andrews-Mac.local", "partial"],
            ["host", "ok"],
          ],
        );
        assert.deepStrictEqual(
          merge(["host", host]).providers.map((provider) => [
            provider.provider,
            provider.totalTokens,
          ]),
          [
            ["claude", 240],
            ["codex", 7],
          ],
        );
      }),
    ),
  );
});
