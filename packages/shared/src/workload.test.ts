import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessEnvironment, HostProcessPlatform } from "./hostProcess.ts";
import { readWorkloadMemoryLimit } from "./workload.ts";
import { resolveSpawnCommand } from "./shell.ts";

it.layer(NodeServices.layer)("workload isolation", (it) => {
  it.effect.each(["darwin", "linux"] as const)("keeps ordinary %s commands unchanged", (platform) =>
    Effect.gen(function* () {
      const command = yield* resolveSpawnCommand(process.execPath, [
        "-e",
        "process.stdout.write(process.argv[1])",
        "a b; $(false)",
      ]).pipe(
        Effect.provideService(HostProcessPlatform, platform),
        Effect.provideService(HostProcessEnvironment, {}),
      );
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      expect(yield* spawner.string(ChildProcess.make(command.command, command.args))).toBe(
        "a b; $(false)",
      );
    }),
  );
  it.effect("refuses to advertise isolation if the server is in the workload group", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const result = yield* readWorkloadMemoryLimit.pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { T3CODE_WORKLOAD_ISOLATION: "1" }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: () => Effect.succeed("0::/t3/workloads\n"),
        }),
        Effect.result,
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "WorkloadIsolationError" },
      });
    }),
  );
  it.effect("reports the enforced memory budget from the control group", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const limit = yield* readWorkloadMemoryLimit.pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { T3CODE_WORKLOAD_ISOLATION: "1" }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path) =>
            Effect.succeed(path === "/proc/self/cgroup" ? "0::/t3/control\n" : "6674526208\n"),
        }),
      );
      expect(limit).toBe(6674526208);
    }),
  );
  it.effect.each(["max", "0", "-1"])("refuses an invalid memory limit %s", (limit) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const result = yield* readWorkloadMemoryLimit.pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HostProcessEnvironment, { T3CODE_WORKLOAD_ISOLATION: "1" }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path) =>
            Effect.succeed(path === "/proc/self/cgroup" ? "0::/t3/control\n" : limit),
        }),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
