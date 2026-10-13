// @effect-diagnostics nodeBuiltinImport:off - the suite seeds and grows real
// transcript trees on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageBucket,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import { createProvisionedLeaseRegistry } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BoxUsageStore, BoxUsageStoreError } from "./boxUsage.ts";
import * as UsageService from "./UsageService.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function claudeLine(id: number, outputTokens: number, model = "claude-fable-5"): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model,
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const setup = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  const transcriptDir = NodePath.join(home, "claude", "projects", "proj");
  yield* Effect.promise(() => NodeFSP.mkdir(transcriptDir, { recursive: true }));
  return {
    home,
    transcript: NodePath.join(transcriptDir, "session.jsonl"),
    settings: {
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: NodePath.join(home, "claude") },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: NodePath.join(home, "codex") },
        },
      },
    },
  };
});

const token = (subject: string) =>
  `h.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.s`;

const serviceLayers = (input: {
  readonly prefix: string;
  readonly home: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
  readonly environment?: NodeJS.ProcessEnv;
  /** Defaults to a store with no cloud box usage. */
  readonly boxUsage?: Layer.Layer<BoxUsageStore>;
}) =>
  Layer.fresh(CursorUsageAccounts.layer).pipe(
    Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
    Layer.provideMerge(AntigravityUsage.layer),
    Layer.provideMerge(ProviderHostLive.layer),
    Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: input.prefix })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(
      input.boxUsage ??
        Layer.succeed(
          BoxUsageStore,
          BoxUsageStore.of({
            replace: () => Effect.void,
            list: () => Effect.succeed([]),
            prune: () => Effect.void,
          }),
        ),
    ),
    Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provideMerge(ServerSettings.layerTest(input.settings)),
    Layer.provideMerge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => HttpClientResponse.fromWeb(request, Response.json({}))),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, {
        HOME: input.home,
        GROK_HOME: NodePath.join(input.home, "grok"),
        PI_CODING_AGENT_DIR: NodePath.join(input.home, "pi"),
        OPENCODE_DATA_DIR: NodePath.join(input.home, "opencode"),
        ANTIGRAVITY_DATA_DIR: NodePath.join(input.home, "antigravity"),
        XDG_CONFIG_HOME: NodePath.join(input.home, "config"),
        APPDATA: NodePath.join(input.home, "config"),
        ...input.environment,
      }),
    ),
  );

function totalOutputTokens(summary: { buckets: readonly { totals: { outputTokens: number } }[] }) {
  return summary.buckets.reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0);
}

describe("UsageService with cloud box usage", () => {
  it.live("names its sources by the host id a cloud box was given", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-usage-host-id",
            home,
            settings,
            environment: { T3CODE_USAGE_HOST_ID: " lease-a " },
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.deepStrictEqual(
        summary.sources
          .filter((source) => source.fingerprint.provider === "claude")
          .map((source) => source.fingerprint.hostId),
        ["lease-a"],
      );
    }).pipe(Effect.scoped),
  );

  it.live("includes stored cloud box usage in the host summary", () =>
    Effect.gen(function* () {
      const { settings, home } = yield* setup;
      const boxHome = "/home/user/.claude/projects";
      const storage = yield* Layer.build(
        BoxUsageStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      );
      yield* Effect.gen(function* () {
        const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
        yield* Effect.promise(() =>
          registry.register({
            leaseId: "lease-a",
            sandboxId: "sandbox-a",
            providerInstanceId: "claude",
          }),
        );
        const store = yield* BoxUsageStore;
        yield* store.replace({
          leaseId: "lease-a",
          origin: "box",
          accountIds: ["claude"],
          usage: {
            sources: [
              {
                fingerprint: {
                  hostId: "box-a",
                  provider: "claude",
                  resolvedHomePath: boxHome,
                  volumeId: "2049:7",
                },
                status: "ok",
                scannedFiles: 1,
                skippedFiles: 0,
                malformedRecords: 0,
                distinctSessions: 1,
                message: null,
              },
            ],
            buckets: [
              {
                day: UsageDay.make("2026-09-01"),
                hourStart: "2026-09-01T03:00:00.000Z",
                provider: "claude",
                model: "claude-fable-5",
                sourcePath: boxHome,
                totals: {
                  uncachedInputTokens: 10,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 9,
                  reasoningTokens: 0,
                },
                costUsd: 0.5,
                cacheSavingsUsd: 0,
                costSource: "modelPriced",
                records: 1,
                unpricedRecords: 0,
                sessions: 1,
              },
            ],
          },
          pulledAt: "2026-09-01T04:00:00.000Z",
        });
        const service = yield* UsageService.make;
        const boxCells = (summary: { buckets: readonly UsageBucket[] }) =>
          summary.buckets
            .filter((bucket) => bucket.sourcePath?.startsWith("lease-a:"))
            .map((bucket) => [
              bucket.day,
              bucket.hourStart,
              bucket.sourcePath,
              bucket.totals.outputTokens,
            ]);

        const daily = yield* service.readSummary({
          timeZone: "America/Los_Angeles",
          sinceDay: UsageDay.make("2026-08-31"),
          untilDay: UsageDay.make("2026-08-31"),
        });
        assert.deepStrictEqual(boxCells(daily), [
          ["2026-08-31", undefined, `lease-a:${boxHome}`, 9],
        ]);
        assert.deepStrictEqual(
          daily.sources
            .filter((source) => source.fingerprint.hostId === "box-a")
            .map((source) => [source.fingerprint.resolvedHomePath, source.sourcePath]),
          [[boxHome, `lease-a:${boxHome}`]],
        );

        const hourly = yield* service.readSummary({
          timeZone: "America/Los_Angeles",
          sinceDay: UsageDay.make("2026-08-31"),
          untilDay: UsageDay.make("2026-08-31"),
          resolution: "hour",
          sinceTime: "2026-09-01T00:00:00.000Z",
          untilTime: "2026-09-01T12:00:00.000Z",
        });
        assert.deepStrictEqual(boxCells(hourly), [
          ["2026-08-31", "2026-09-01T03:00:00.000Z", `lease-a:${boxHome}`, 9],
        ]);
      }).pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-box-usage",
            home,
            settings,
            boxUsage: Layer.succeedContext(storage),
          }),
        ),
        Effect.provideContext(storage),
      );
    }).pipe(Effect.scoped),
  );

  it.live("still returns this host's usage when stored cloud box usage cannot be read", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(() => NodeFSP.writeFile(transcript, claudeLine(1, 5)));
      const service = yield* UsageService.make.pipe(
        Effect.provide(
          serviceLayers({
            prefix: "usage-service-box-usage-unreadable",
            home,
            settings,
            boxUsage: Layer.succeed(
              BoxUsageStore,
              BoxUsageStore.of({
                replace: () => Effect.void,
                list: () =>
                  new BoxUsageStoreError({
                    operation: "list",
                    cause: new Error("no such table: box_usage_hours"),
                  }),
                prune: () => Effect.void,
              }),
            ),
          }),
        ),
      );
      const summary = yield* service.readSummary(WINDOW);
      assert.strictEqual(totalOutputTokens(summary), 5);
    }).pipe(Effect.scoped),
  );

  it.live("reads hourly history for a host without Cursor or missing sources", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(transcript, claudeLine(1, 5));
        const authPath = NodePath.join(home, "config", "cursor", "auth.json");
        await NodeFSP.mkdir(NodePath.dirname(authPath), { recursive: true });
        await NodeFSP.writeFile(
          authPath,
          encodeUnknownJsonString({
            accessToken: token("auth0|user_a"),
          }),
        );
      });
      yield* TestClock.setTime(Date.parse("2026-08-01T12:30:00Z"));
      const service = yield* UsageService.make.pipe(
        Effect.provide(serviceLayers({ prefix: "usage-service-history", home, settings })),
      );
      const history = yield* service.readHistory({ sinceTime: "2026-08-01T09:30:00Z" });
      const claudeDir = yield* Effect.promise(() =>
        NodeFSP.realpath(NodePath.join(home, "claude", "projects")),
      );
      assert.deepStrictEqual(
        history.sources.map((source) => [
          source.fingerprint.provider,
          source.fingerprint.resolvedHomePath,
          source.status,
        ]),
        [["claude", claudeDir, "ok"]],
      );
      assert.deepStrictEqual(
        history.buckets.map((bucket) => [
          bucket.day,
          bucket.hourStart,
          bucket.provider,
          bucket.sourcePath,
          bucket.totals.outputTokens,
        ]),
        [["2026-08-01", "2026-08-01T10:00:00.000Z", "claude", claudeDir, 5]],
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
