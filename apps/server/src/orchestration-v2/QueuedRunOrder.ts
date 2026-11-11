import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

/** Automatic input does not jump the queue: it joins whichever queued turn starts next. */
export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): ReadonlyArray<OrchestrationV2Run> {
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
}
