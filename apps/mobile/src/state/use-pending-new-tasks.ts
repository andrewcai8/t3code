import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(composerDraftsAtom);
  const threadRefs = useThreadRefs();
  const knownThreadKeys = useMemo(
    () => new Set(threadRefs.map((ref) => scopedThreadKey(ref.environmentId, ref.threadId))),
    [threadRefs],
  );
  return useMemo(
    () =>
      buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
        drafts,
        knownThreadKeys,
      }),
    [queuedMessagesByThreadKey, drafts, knownThreadKeys],
  );
}
