import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import { resolveCodexProviderEnvironment } from "../../provider/codexProviderEnvironment.ts";
import * as ProviderEventLoggers from "../../provider/ProviderEventLoggers.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
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
      Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, {
        CODEX_HOME: "/ambient/.codex_other",
        PATH: "/usr/bin",
      }),
    ),
  );

  it("runs an instance in its configured home, then its own CODEX_HOME, then the shared home", () => {
    const ambient = { CODEX_HOME: "/Users/andrew/.codex_ac3", PATH: "/usr/bin" };
    const instanceHome = [
      { name: "CODEX_HOME", value: "/Users/andrew/.codex_work", sensitive: false },
    ];
    const shared = { sharedHomePath: "/Users/andrew/.codex", effectiveHomePath: undefined };
    const resolveHome = (...args: Parameters<typeof resolveCodexProviderEnvironment>) =>
      resolveCodexProviderEnvironment(...args).CODEX_HOME;

    assert.deepEqual(
      [
        resolveHome(instanceHome, ambient, {
          ...shared,
          effectiveHomePath: "/Users/andrew/.codex_ac2",
        }),
        resolveHome(instanceHome, ambient, shared),
        resolveHome([], ambient, shared),
      ],
      ["/Users/andrew/.codex_ac2", "/Users/andrew/.codex_work", "/Users/andrew/.codex"],
    );
  });
});
