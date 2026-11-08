// @effect-diagnostics nodeBuiltinImport:off - the suite makes a temporary home
// outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as CursorAccountReader from "@t3tools/provider-cursor/server/CursorAccountReader";
import * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import { MuseUsageHome } from "@t3tools/provider-muse/server";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CodexUsageHistory from "./CodexUsageHistory.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as UsageService from "./UsageService.ts";

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

// Saved usage is pruned after the retention window, so "now" stays near the records.
const SAVED_USAGE_NOW = Date.parse("2026-08-15T00:00:00Z");

const OUTPUT_BY_ACCOUNT: Record<string, number> = { user_a: 3, user_b: 5 };

/** Stands in for Cursor's dashboard API: an API key names its account. */
const readAccount: CursorAccountReader.CursorAccountReader["Service"]["read"] = (credential) =>
  Effect.sync(() => {
    const accountKey = credential.apiKey;
    const record: UsageRecord = {
      provider: "cursor",
      timestampMs: Date.parse("2026-08-01T10:00:00Z"),
      model: "auto",
      sessionId: "conversation-1",
      totals: {
        uncachedInputTokens: 1,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: OUTPUT_BY_ACCOUNT[accountKey] ?? 0,
        reasoningTokens: 0,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `cursor-account:${accountKey}:1`,
    };
    return { accountKey, records: [record], missing: false, error: null };
  });

const makeHome = Effect.gen(function* () {
  const home = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-service-cursor-logins-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  );
  return home;
});

const cursorInstance = (apiKey: string) => ({
  driver: ProviderDriverKind.make("cursor"),
  environment: [{ name: "CURSOR_API_KEY", value: apiKey, sensitive: false }],
});

const readSummary = (
  home: string,
  prefix: string,
  providerInstances: Record<string, ReturnType<typeof cursorInstance>>,
) =>
  Effect.gen(function* () {
    const service = yield* UsageService.make;
    return yield* service.readSummary({ ...WINDOW, awaitRefresh: true });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.fresh(CursorUsageAccounts.layer).pipe(
        Layer.provide(
          Layer.succeed(CursorAccountReader.CursorAccountReader, { read: readAccount }),
        ),
        Layer.provideMerge(AntigravityUsage.layer),
        Layer.provideMerge(MuseUsageHome.layer),
        Layer.provideMerge(ProviderHostLive.layer),
        Layer.provideMerge(CodexUsageHistory.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
        Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
        Layer.provideMerge(
          Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), NodePath.join(home, prefix))),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provideMerge(
          ServerSettings.layerTest({
            providerInstances: Object.fromEntries(
              Object.entries(providerInstances).map(([id, instance]) => [
                ProviderInstanceId.make(id),
                instance,
              ]),
            ),
          }),
        ),
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
            HOME: home,
            GROK_HOME: NodePath.join(home, "grok"),
            PI_CODING_AGENT_DIR: NodePath.join(home, "pi"),
            OPENCODE_DATA_DIR: NodePath.join(home, "opencode"),
            ANTIGRAVITY_DATA_DIR: NodePath.join(home, "antigravity"),
            XDG_CONFIG_HOME: NodePath.join(home, "config"),
          }),
        ),
      ),
    ),
  );

describe("UsageService Cursor history", () => {
  it.effect("keeps a removed account's history", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(SAVED_USAGE_NOW);
      const home = yield* makeHome;
      yield* readSummary(home, "usage-service-cursor-removed", {
        "cursor-work": cursorInstance("user_b"),
      });

      const summary = yield* readSummary(home, "usage-service-cursor-removed", {});

      assert.deepStrictEqual(
        summary.sources
          .filter((source) => source.fingerprint.provider === "cursor")
          .map((source) => [source.fingerprint.hostId, source.status]),
        [["cursor.com", "ok"]],
      );
      assert.strictEqual(
        summary.buckets
          .filter((bucket) => bucket.provider === "cursor")
          .reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
        5,
      );
    }).pipe(Effect.scoped),
  );
});
