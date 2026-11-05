import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { environmentThreadShells } from "./threads";
import { newTaskComposerDraftsAtom } from "./use-composer-drafts";
import { useQueuedMessagesAwaitingThreads } from "./cloud-entities";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useQueuedMessagesAwaitingThreads();
  const drafts = useAtomValue(newTaskComposerDraftsAtom);
  const hiddenKeys = useAtomValue(environmentThreadShells.hiddenThreadKeysAtom);
  // A delivered creation can stay queued after its thread is live and hidden.
  const queuedMessages = flattenQueuedThreadMessages(queuedMessagesByThreadKey).filter(
    (message) => !hiddenKeys.has(threadKey(message)),
  );
  return buildPendingNewTasks({ queuedMessages, drafts });
}
