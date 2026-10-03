import type { ScopedThreadRef } from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import type { QueuedThreadMessage } from "./thread-outbox-model";

/**
 * The outbox's queued messages without the creations whose thread already exists. The outbox
 * drops a delivered creation only after its disk write lands, which can trail the thread's
 * arrival. Once the thread exists, its own row stands for the task.
 */
export function withoutArrivedCreations(
  queuedMessagesByThreadKey: Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>> {
  const known = new Set(threadRefs.map((ref) => scopedThreadKey(ref.environmentId, ref.threadId)));
  return Object.fromEntries(
    Object.entries(queuedMessagesByThreadKey).map(([key, messages]) => [
      key,
      messages.filter(
        (message) =>
          !message.creation || !known.has(scopedThreadKey(message.environmentId, message.threadId)),
      ),
    ]),
  );
}
