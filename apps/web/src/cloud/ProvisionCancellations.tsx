import { useEffect, useEffectEvent } from "react";

import { forgetProvisionedSandbox } from "./provisionedSandboxLeases";
import { drainProvisionCancellations, subscribeProvisionCancellations } from "./provisionRequests";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/** Disposes the boxes whose drafts were cancelled before their provisioning finished. */
export function ProvisionCancellations() {
  const dispose = useAtomCommand(serverEnvironment.disposeProvisionedEnvironment, {
    reportFailure: false,
  });

  const cancelRequests = useEffectEvent(async () => {
    const disposed = await drainProvisionCancellations(async (request) => {
      const result = await dispose({
        environmentId: request.managerEnvironmentId,
        input: { requestId: request.input.requestId },
      });
      return result._tag === "Success" ? result.value : null;
    });
    for (const draftId of disposed) forgetProvisionedSandbox(draftId);
  });

  useEffect(() => {
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        await cancelRequests();
      } finally {
        draining = false;
      }
    };
    const trigger = () => {
      void drain();
    };
    const unsubscribe = subscribeProvisionCancellations(trigger);
    trigger();
    const interval = globalThis.setInterval(trigger, 30_000);
    return () => {
      unsubscribe();
      globalThis.clearInterval(interval);
    };
  }, []);

  return null;
}
