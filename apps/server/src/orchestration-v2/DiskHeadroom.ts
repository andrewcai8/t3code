// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";

/** Below this much free space an agent is told the disk is nearly full before it writes more. */
const LOW_DISK_BYTES = 2 * 1024 ** 3;

/** What an agent is told when its working directory's disk is nearly full; empty otherwise. */
export function lowDiskNote(freeBytes: number): string {
  if (freeBytes >= LOW_DISK_BYTES) return "";
  const free =
    freeBytes >= 1024 ** 3
      ? `${(freeBytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(0, Math.floor(freeBytes / 1024 ** 2))} MB`;
  return `Note: this machine's disk is nearly full, with ${free} free. Free space, such as build outputs or package caches, before writing large files; a full disk stops this chat from saving its work.`;
}

/** The note for `cwd`'s disk, or empty when it has room or cannot be read. */
export const lowDiskNoteFor = (cwd: string | null | undefined): Effect.Effect<string> =>
  cwd
    ? Effect.tryPromise(() => NodeFSP.statfs(cwd)).pipe(
        Effect.map((stats) => lowDiskNote(stats.bavail * stats.bsize)),
        Effect.orElseSucceed(() => ""),
      )
    : Effect.succeed("");
