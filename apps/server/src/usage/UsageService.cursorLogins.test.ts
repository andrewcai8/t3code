// @effect-diagnostics nodeBuiltinImport:off - the suite seeds real Cursor
// login files on disk, outside the service's Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BoxUsageStore } from "./boxUsage.ts";
import * as CursorUsageReader from "./cursorUsageReader.ts";
import * as UsageService from "./UsageService.ts";

const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const WINDOW: UsageSummaryInput = {
  timeZone: "UTC",
  sinceDay: UsageDay.make("2026-07-31"),
  untilDay: UsageDay.make("2026-08-02"),
};

const token = (subject: string) =>
  `h.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.s`;

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
    // Scoped inside the state directory, so the Cursor account cache write
    // lands before the directory is removed.
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix }).pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(CursorUsageReader.layer),
        Layer.provideMerge(
          Layer.succeed(
            BoxUsageStore,
            BoxUsageStore.of({
              replace: () => Effect.void,
              list: () => Effect.succeed([]),
              prune: () => Effect.void,
            }),
          ),
        ),
        Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
        Layer.provideMerge(
          ServerSettings.layerTest({
            providers: {
              claudeAgent: { homePath: NodePath.join(home, "claude") },
              codex: { homePath: NodePath.join(home, "codex") },
            },
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
          Layer.succeed(HostProcessEnvironment, {
            HOME: home,
            GROK_HOME: NodePath.join(home, "grok"),
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
      const logins = [
        { config: "config", subject: "auth0|user_a" },
        { config: "config-a", subject: "auth0|user_a" },
        { config: "config-b", subject: "auth0|user_b" },
        { config: "config-c", subject: "auth0|user_a" },
      ];
      for (const { config, subject } of logins) {
        yield* writeLogin(home, config, encodeUnknownJsonString({ accessToken: token(subject) }));
      }
      const outputByUser: Record<string, number> = { user_a: 3, user_b: 5 };
      const realFetch = globalThis.fetch;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          globalThis.fetch = (async (_url: string, init: RequestInit) => {
            const cookie = new Headers(init.headers).get("Cookie") ?? "";
            const user = decodeURIComponent(cookie).split("=")[1]?.split("::")[0] ?? "";
            return Response.json({
              totalUsageEventsCount: 1,
              usageEventsDisplay: [
                {
                  timestamp: String(Date.parse("2026-08-01T10:00:00Z")),
                  model: "auto",
                  tokenUsage: { inputTokens: 1, outputTokens: outputByUser[user] ?? 0 },
                },
              ],
            });
          }) as typeof fetch;
        }),
        () =>
          Effect.sync(() => {
            globalThis.fetch = realFetch;
          }),
      );

      const summary = yield* readSummary(home, "usage-service-cursor-instances", {
        cursor: cursorInstance(home, "config-a"),
        "cursor-work": cursorInstance(home, "config-b"),
        "cursor-alias": cursorInstance(home, "config-c"),
      });

      const cursorSources = summary.sources.filter(
        (source) => source.fingerprint.provider === "cursor",
      );
      assert.deepStrictEqual(
        cursorSources.map((source) => [source.fingerprint.hostId, source.status]),
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
