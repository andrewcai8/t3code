// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

/**
 * Below this much free space an agent is told to clean up after itself. A cloud box warns early
 * enough that one turn installing dependencies into several worktrees still has room to stop; a
 * user's own machine only when it is nearly full.
 */
const lowDiskBytes = (box: boolean) => (box ? 10 : 2) * 1024 ** 3;

/** What an agent is told when its working directory's disk is running low; empty otherwise. */
export function lowDiskNote(freeBytes: number, box: boolean): string {
  if (freeBytes >= lowDiskBytes(box)) return "";
  const free =
    freeBytes >= 1024 ** 3
      ? `${(freeBytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(0, Math.floor(freeBytes / 1024 ** 2))} MB`;
  return `Note: this machine's disk is running low, with ${free} free. Remove worktrees, dependency installs and build outputs you created and no longer need before installing or writing more; a full disk stops this chat from saving its work.`;
}

/** The note for `cwd`'s disk, or empty when it has room or cannot be read. */
export const lowDiskNoteFor = (cwd: string | null | undefined): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (!cwd) return "";
    // Only a box's preparation names its host for usage.
    const box = Boolean((yield* HostProcessEnvironment).T3CODE_USAGE_HOST_ID?.trim());
    return yield* Effect.tryPromise(() => NodeFSP.statfs(cwd)).pipe(
      Effect.map((stats) => lowDiskNote(stats.bavail * stats.bsize, box)),
      Effect.orElseSucceed(() => ""),
    );
  });
