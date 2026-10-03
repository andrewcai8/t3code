import type { EnvironmentId } from "@t3tools/contracts";

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

/**
 * Refuses a pairing whose server is not the environment the caller expected, checked before the
 * pairing grant is consumed. Null when nothing was expected or the server matches.
 */
export function pairedEnvironmentMismatch(
  expected: EnvironmentId | undefined,
  actual: EnvironmentId,
): ConnectionBlockedError | null {
  return expected === undefined || expected === actual
    ? null
    : new ConnectionBlockedError({
        reason: "configuration",
        detail: "The paired server does not match the expected environment.",
      });
}
