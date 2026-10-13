// @effect-diagnostics nodeBuiltinImport:off - the suite seeds real Cursor
// login files on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as AntigravityUsage from "../provider/Drivers/AntigravityUsage.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const OUTPUT_BY_ACCOUNT: Record<string, number> = { user_a: 3, user_b: 5 };

/** Stands in for Cursor's dashboard API: a login file names its account. */
const readAccount: CursorAccountReader.CursorAccountReader["Service"]["read"] = (credential) =>
  Effect.promise(async () => {
    const accountKey =
      typeof credential === "string" ? (await NodeFSP.readFile(credential, "utf8")).trim() : "";
    if (!(accountKey in OUTPUT_BY_ACCOUNT)) {
      return {
        accountKey: null,
        records: [],
        missing: false,
        error: "Cursor credentials could not be read.",
      };
    }
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

const writeLogin = (home: string, config: string, contents: string) =>
  Effect.promise(async () => {
    const directory = NodePath.join(home, config, "cursor");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "auth.json"), contents);
  });

const cursorInstance = (home: string, config: string) => ({
  driver: ProviderDriverKind.make("cursor"),
  environment: [{ name: "XDG_CONFIG_HOME", value: NodePath.join(home, config), sensitive: false }],
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
        Layer.provideMerge(ProviderHostLive.layer),
        Layer.provideMerge(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
        Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), NodePath.join(home, prefix))),
        Layer.provideMerge(NodeServices.layer),
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

describe("UsageService with several Cursor logins", () => {
  it.live("reads every Cursor instance's login and counts each account once", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      // The host's default login and two instance logins share user_a.
      for (const [config, account] of [
        ["config", "user_a"],
        ["config-a", "user_a"],
        ["config-b", "user_b"],
        ["config-c", "user_a"],
      ] as const) {
        yield* writeLogin(home, config, account);
      }

      const summary = yield* readSummary(home, "usage-service-cursor-instances", {
        cursor: cursorInstance(home, "config-a"),
        "cursor-work": cursorInstance(home, "config-b"),
        "cursor-alias": cursorInstance(home, "config-c"),
      });

      assert.deepStrictEqual(
        summary.sources
          .filter((source) => source.fingerprint.provider === "cursor")
          .map((source) => [source.fingerprint.hostId, source.status]),
        [
          ["cursor.com", "ok"],
          ["cursor.com", "ok"],
        ],
      );
      assert.strictEqual(
        summary.buckets
          .filter((bucket) => bucket.provider === "cursor")
          .reduce((sum, bucket) => sum + bucket.totals.outputTokens, 0),
        8,
      );
    }).pipe(Effect.scoped),
  );

  it.live("reports only the Cursor instance whose saved login cannot be read", () =>
    Effect.gen(function* () {
      const home = yield* makeHome;
      yield* writeLogin(home, "config-invalid", "invalid json");

      const summary = yield* readSummary(home, "usage-service-cursor-invalid-and-missing", {
        cursor: cursorInstance(home, "config-invalid"),
        "cursor-empty": cursorInstance(home, "config-empty"),
      });

      assert.deepStrictEqual(
        summary.sources
          .filter((source) => source.fingerprint.provider === "cursor")
          .map((source) => source.message),
        ["Cursor credentials could not be read."],
      );
    }).pipe(Effect.scoped),
  );
});
