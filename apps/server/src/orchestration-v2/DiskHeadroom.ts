// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";

/**
 * Below this much free space an agent is told to clean up after itself. Early enough that one
 * turn installing dependencies into several worktrees still has room to stop.
 */
const LOW_DISK_BYTES = 10 * 1024 ** 3;

/** What an agent is told when its working directory's disk is running low; empty otherwise. */
export function lowDiskNote(freeBytes: number): string {
  if (freeBytes >= LOW_DISK_BYTES) return "";
  const free =
    freeBytes >= 1024 ** 3
      ? `${(freeBytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(0, Math.floor(freeBytes / 1024 ** 2))} MB`;
  return `Note: this machine's disk is running low, with ${free} free. Remove worktrees, dependency installs and build outputs you created and no longer need before installing or writing more; a full disk stops this chat from saving its work.`;
}

/** The note for `cwd`'s disk, or empty when it has room or cannot be read. */
export const lowDiskNoteFor = (cwd: string | null | undefined): Effect.Effect<string> =>
  cwd
    ? Effect.tryPromise(() => NodeFSP.statfs(cwd)).pipe(
        Effect.map((stats) => lowDiskNote(stats.bavail * stats.bsize)),
        Effect.orElseSucceed(() => ""),
      )
    : Effect.succeed("");
