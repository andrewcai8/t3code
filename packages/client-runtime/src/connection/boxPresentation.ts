import { workspaceMissingError } from "./boxErrors.ts";
import { type ConnectionTarget, connectionBox } from "./model.ts";
import type { EnvironmentConnectionPresentation } from "./presentation.ts";

/** What a cloud box is called in status copy. */
export const BOX_STATUS_NAME = "this chat's cloud machine";

/**
 * What status copy calls a connection, mid-sentence. A box's saved label names the first machine
 * it ran on and goes stale when the box moves, so a box is named by its role.
 */
export function connectionStatusName(target: ConnectionTarget): string {
  return connectionBox(target) === null ? target.label : BOX_STATUS_NAME;
}

/** A saved workspace marked missing reads as removed whatever its supervisor is doing. */
export function presentMissingWorkspace(
  target: ConnectionTarget | undefined,
): EnvironmentConnectionPresentation | null {
  return target?._tag === "BearerConnectionTarget" && target.workspaceStatus === "missing"
    ? {
        phase: "error",
        error: workspaceMissingError().message,
        traceId: null,
        blockedReason: "workspace-missing",
      }
    : null;
}
