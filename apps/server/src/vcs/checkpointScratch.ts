// @effect-diagnostics nodeBuiltinImport:off - clears a crashed server's scratch synchronously before the driver exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Where a checkpoint capture keeps its throwaway index, so the multi-megabyte rewrites never wear
 * the disk; null where there is no tmpfs. The directory is the user's, shared by every server of
 * that user, and each server works in a subdirectory named by its pid.
 */
export const checkpointScratchRoot = (platform: NodeJS.Platform, uid: number | undefined) =>
  platform === "linux" ? NodePath.join("/dev/shm", `t3-checkpoint-${uid ?? "user"}`) : null;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** Clears what a crashed server left behind: this pid's directory and any whose pid is gone. */
export const sweepCheckpointScratch = (root: string, ownPid: number) => {
  try {
    for (const name of NodeFS.readdirSync(root)) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (pid !== ownPid && isAlive(pid)) continue;
      NodeFS.rmSync(NodePath.join(root, name), { recursive: true, force: true });
    }
  } catch {
    // No root yet, or not ours to clear.
  }
};

/** A Git or filesystem failure that means the device is full, however deeply it is wrapped. */
export const isOutOfSpace = (error: unknown, depth = 0): boolean => {
  if (typeof error !== "object" || error === null || depth > 4) return false;
  const { code, message, detail, cause, reason } = error as Record<string, unknown>;
  return (
    code === "ENOSPC" ||
    [message, detail].some(
      (text) => typeof text === "string" && text.includes("No space left on device"),
    ) ||
    isOutOfSpace(cause, depth + 1) ||
    isOutOfSpace(reason, depth + 1)
  );
};
