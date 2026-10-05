import type { RemoteEnvironmentAuthError } from "../authorization/remote.ts";
import { ConnectionBlockedError } from "./model.ts";

export function workspaceMissingError(): ConnectionBlockedError {
  return new ConnectionBlockedError({
    reason: "workspace-missing",
    detail: "This workspace no longer exists. Its saved conversation is still available.",
  });
}

// A paused box's gateway answers 404 (Namespace), 502 (E2B) or 503 (nothing listening).
const NOT_SERVING_STATUSES: ReadonlySet<number> = new Set([404, 502, 503]);

/** Whether a remote answer means a box is not serving yet, rather than that it failed. */
export function isBoxNotServing(error: RemoteEnvironmentAuthError): boolean {
  return (
    error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" &&
    NOT_SERVING_STATUSES.has(error.status)
  );
}
