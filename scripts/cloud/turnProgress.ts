import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";

/** What one turn's thread stream has shown so far: the thread folded the way the web folds it. */
export interface TurnProgress {
  readonly projection: OrchestrationV2ThreadProjection | null;
  /** Events at or below it are already folded into `projection`. */
  readonly sequence: number;
  readonly assistant: ReadonlyMap<string, string>;
  readonly firstOutputAt: number | null;
  readonly completedAt: number | null;
  readonly error: string | null;
}
export const initialProgress: TurnProgress = {
  projection: null,
  sequence: -1,
  assistant: new Map(),
  firstOutputAt: null,
  completedAt: null,
  error: null,
};
const SETTLED_RUN = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
export const advanceTurn = (
  progress: TurnProgress,
  item: OrchestrationV2ThreadStreamItem,
  sentMessageId: string,
  now: number,
): TurnProgress => {
  const folded =
    item.kind === "snapshot"
      ? { projection: item.projection, sequence: item.snapshotSequence }
      : item.kind === "synchronized" || item.sequence <= progress.sequence
        ? null
        : {
            projection:
              item.kind === "event"
                ? applyOrchestrationV2ProjectionEvent(progress.projection, item.event)
                : progress.projection,
            sequence: item.sequence,
          };
  if (folded === null || folded.projection === null) return { ...progress, ...folded };
  const { projection } = folded;
  // The run the sent message started; a late update to the previous turn's run is not ours.
  const run = projection.runs
    .filter((candidate) => candidate.userMessageId === sentMessageId)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  const replies = run
    ? projection.messages.filter(
        (message) => message.role === "assistant" && message.runId === run.id,
      )
    : [];
  const settled = run !== undefined && SETTLED_RUN.has(run.status);
  const failure = run
    ? projection.turnItems.findLast((entry) => entry.type === "error" && entry.runId === run.id)
    : undefined;
  return {
    ...folded,
    assistant: new Map(replies.map((message) => [message.id, message.text])),
    firstOutputAt:
      progress.firstOutputAt ?? (replies.some((message) => message.text.trim()) ? now : null),
    completedAt: progress.completedAt ?? (settled ? now : null),
    error:
      settled && run.status === "failed"
        ? failure?.type === "error"
          ? failure.failure.message
          : "run failed"
        : null,
  };
};
