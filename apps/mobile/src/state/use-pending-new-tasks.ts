import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";
import { useQueuedMessagesAwaitingThreads } from "./cloud-entities";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useQueuedMessagesAwaitingThreads();
  const drafts = useAtomValue(composerDraftsAtom);
  return useMemo(
    () =>
      buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
        drafts,
      }),
    [queuedMessagesByThreadKey, drafts],
  );
}
