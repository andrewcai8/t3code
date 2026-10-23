import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

const LSOF_TIMEOUT = Duration.seconds(20);
const LSOF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ProcessUse =
  | { readonly status: "free" }
  | { readonly status: "busy"; readonly pid: number }
  /** The host gave no trustworthy answer, so a caller must treat the folder as in use. */
  | { readonly status: "unknown"; readonly reason: string };

/**
 * Whether any live process has its working directory at or below a folder.
 *
 * Linux reads `/proc/<pid>/cwd`, which needs no helper binary. macOS asks
 * `lsof`. Other hosts, Windows included, have no cheap equivalent, so they
 * answer "unknown". Processes of other users are invisible to both, which
 * matches the privileges the server needs to delete the folder anyway.
 */
export const makeProcessUseProbe = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const within = (root: string, cwd: string) => {
    const relative = path.relative(root, cwd);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const fromProc = Effect.fnUntraced(function* (root: string) {
    const names = yield* fs.readDirectory("/proc");
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      // A process that exits mid-scan, or belongs to another user, has no readable cwd.
      const cwd = yield* fs.readLink(`/proc/${name}/cwd`).pipe(Effect.orElseSucceed(() => null));
      if (cwd !== null && within(root, cwd)) return { status: "busy", pid: Number(name) } as const;
    }
    return { status: "free" } as const;
  });

  const fromLsof = Effect.fnUntraced(function* (root: string) {
    const result = yield* processRunner.run({
      command: "lsof",
      // -b skips kernel calls that can hang on a dead network mount.
      args: ["-n", "-P", "-w", "-b", "-a", "-d", "cwd", "-F", "pn"],
      timeout: LSOF_TIMEOUT,
      // A truncated list could hide the one process that matters.
      maxOutputBytes: LSOF_MAX_OUTPUT_BYTES,
    });
    // lsof exits 1 when it could not inspect some processes but still listed the rest.
    if (result.code !== 0 && result.code !== 1) return yield* Effect.fail(result);
    let pid = 0;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && within(root, line.slice(1)))
        return { status: "busy", pid } as const;
    }
    return { status: "free" } as const;
  });

  return Effect.fn("WorkspaceProcessUse.probe")(function* (root: string) {
    const probe = platform === "linux" ? fromProc : platform === "darwin" ? fromLsof : null;
    if (probe === null) {
      return {
        status: "unknown",
        reason: "running processes can't be checked on this operating system",
      } satisfies ProcessUse;
    }
    return yield* probe(root).pipe(
      Effect.catch(() =>
        Effect.succeed({
          status: "unknown",
          reason: "running processes could not be checked",
        } satisfies ProcessUse),
      ),
    );
  });
});
