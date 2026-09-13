import { HostProcessEnvironment, HostProcessPlatform } from "./hostProcess.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

export const workloadIsolationEnabled = Effect.gen(function* () {
  return (
    (yield* HostProcessPlatform) === "linux" &&
    (yield* HostProcessEnvironment).T3CODE_WORKLOAD_ISOLATION === "1"
  );
});

export function workloadCommand(command: string, args: ReadonlyArray<string>) {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      'printf "%s\\n" "$$" > /sys/fs/cgroup/t3/workloads/cgroup.procs || { echo "T3 workload memory isolation is unavailable" >&2; exit 125; }; exec "$@"',
      "t3-workload",
      command,
      ...args,
    ],
    shell: false,
  };
}

export const readWorkloadMemoryLimit = Effect.gen(function* () {
  if (!(yield* workloadIsolationEnabled)) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const membership = yield* fs.readFileString("/proc/self/cgroup");
  if (!membership.split("\n").includes("0::/t3/control")) {
    return yield* new WorkloadIsolationError({
      message: "T3 must start in its control cgroup when workload isolation is enabled.",
    });
  }
  const limit = yield* fs.readFileString("/sys/fs/cgroup/t3/workloads/memory.max");
  return yield* Schema.decodeUnknownEffect(
    Schema.NumberFromString.pipe(
      Schema.refine(Schema.is(Schema.Int.check(Schema.isGreaterThan(0)))),
    ),
  )(limit.trim());
});

export class WorkloadIsolationError extends Schema.TaggedError<WorkloadIsolationError>()(
  "WorkloadIsolationError",
  { message: Schema.String },
) {}
