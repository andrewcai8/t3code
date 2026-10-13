import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import { resolveCodexProviderEnvironment } from "../../provider/codexProviderEnvironment.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
};
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

describe("Codex instance home", () => {
  it.effect("runs a shared-home instance against the shared home, not an ambient CODEX_HOME", () =>
    Effect.gen(function* () {
      const spawnedCodexHomes: Array<string | undefined> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command))
          spawnedCodexHomes.push(command.options.env?.CODEX_HOME);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const path = yield* Path.Path;
      const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: DEFAULT_CODEX_SETTINGS,
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CodexAdapterV2.layerAppServerClientFactory,
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-shared-home-" }),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );

      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-shared-home"),
          providerSessionId: ProviderSessionId.make("provider-session-shared-home"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.scoped, Effect.exit);

      assert.deepEqual(spawnedCodexHomes, [path.join(NodeOS.homedir(), ".codex")]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, {
        CODEX_HOME: "/ambient/.codex_other",
        PATH: "/usr/bin",
      }),
    ),
  );

  it.effect(
    "runs an instance in its configured home, then its own CODEX_HOME, then the shared home",
    () =>
      Effect.gen(function* () {
        const ambient = { CODEX_HOME: "/Users/andrew/.codex_ac3", PATH: "/usr/bin" };
        const instanceHome = [
          { name: "CODEX_HOME", value: "/Users/andrew/.codex_work", sensitive: false },
        ];
        const shared = { sharedHomePath: "/Users/andrew/.codex", effectiveHomePath: undefined };
        const resolveHome = (...args: Parameters<typeof resolveCodexProviderEnvironment>) =>
          resolveCodexProviderEnvironment(...args).pipe(Effect.map((env) => env.CODEX_HOME));

        assert.deepEqual(
          [
            yield* resolveHome(instanceHome, ambient, {
              ...shared,
              effectiveHomePath: "/Users/andrew/.codex_ac2",
            }),
            yield* resolveHome(instanceHome, ambient, shared),
            yield* resolveHome([], ambient, shared),
          ],
          ["/Users/andrew/.codex_ac2", "/Users/andrew/.codex_work", "/Users/andrew/.codex"],
        );
      }),
  );
});
