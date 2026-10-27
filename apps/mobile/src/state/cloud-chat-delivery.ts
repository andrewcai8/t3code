import { claimFirstTurnBox } from "@t3tools/client-runtime/cloud";
import { connectionBox } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { holdBoxDemand } from "./box-demand";
import { provisionedSandboxLeases } from "./provision-stores";
import { serverEnvironment } from "./server";
import { threadOutboxManager } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";

/**
 * The outbox delivery's cloud box side: a message queued for a box brings the box online until it
 * leaves the queue. Returns the release.
 */
export function holdQueuedBoxDemand(): () => void {
  const held = new Map<EnvironmentId, () => void>();
  const sync = (queued: Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>) => {
    const wanted = new Set(
      Object.values(queued).flatMap((messages) => messages.map((message) => message.environmentId)),
    );
    for (const environmentId of wanted) {
      if (!held.has(environmentId)) held.set(environmentId, holdBoxDemand(environmentId));
    }
    for (const [environmentId, release] of held) {
      if (wanted.has(environmentId)) continue;
      release();
      held.delete(environmentId);
    }
  };
  const stop = appAtomRegistry.subscribe(threadOutboxManager.queuedMessagesByThreadKeyAtom, sync, {
    immediate: true,
  });
  return () => {
    stop();
    for (const release of held.values()) release();
    held.clear();
  };
}

/**
 * Runs once a creation's first turn starts: the first turn on a cloud machine this phone started
 * claims it on its host, so no device offers it to a new chat. The turn already started, so a
 * failed claim only logs.
 */
export function claimFirstTurnCloudBox(message: QueuedThreadMessage): void {
  void claimFirstTurnBox(
    provisionedSandboxLeases,
    {
      claim: async (request) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          serverEnvironment.claimProvisionedEnvironment,
          request,
          { reportFailure: false },
        );
        return AsyncResult.isSuccess(result) && result.value.kind === "claimed";
      },
      refresh: (managerId) =>
        serverEnvironment.refreshProvisionedBoxes(appAtomRegistry, [managerId]),
      boxManager: (environmentId) => {
        const target = appAtomRegistry
          .get(environmentCatalog.catalogValueAtom)
          .entries.get(environmentId)?.target;
        return target === undefined ? null : (connectionBox(target)?.managerId ?? null);
      },
      warn: (attempt) =>
        console.warn("[thread-outbox] could not claim the cloud machine for its first turn", {
          threadId: message.threadId,
          attempt,
        }),
    },
    { environmentId: message.environmentId, threadId: message.threadId },
  );
}
