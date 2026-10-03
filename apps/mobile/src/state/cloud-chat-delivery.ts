import { claimFirstTurnBox } from "@t3tools/client-runtime/cloud";
import { connectionBox } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { useBoxesDemand } from "./box-demand";
import { provisionedSandboxLeases } from "./provision-stores";
import { serverEnvironment } from "./server";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { useAtomCommand } from "./use-atom-command";

/**
 * The outbox drain's cloud box side. A message queued for a box brings the box online until it
 * is delivered. The returned callback runs once a creation's first turn starts: the first turn on
 * a cloud machine this phone started claims it on its host, so no device offers it to a new chat.
 * The turn already started, so a failed claim only logs.
 */
export function useCloudChatDelivery(
  queuedMessagesByThreadKey: Readonly<Record<string, ReadonlyArray<QueuedThreadMessage>>>,
): (message: QueuedThreadMessage) => void {
  useBoxesDemand(
    Object.values(queuedMessagesByThreadKey).flatMap((messages) =>
      messages.map((message) => message.environmentId),
    ),
  );
  const claimBox = useAtomCommand(serverEnvironment.claimProvisionedEnvironment, {
    reportFailure: false,
  });
  return useCallback(
    (message: QueuedThreadMessage) =>
      void claimFirstTurnBox(
        provisionedSandboxLeases,
        {
          claim: async (request) => {
            const result = await claimBox(request);
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
      ),
    [claimBox],
  );
}
