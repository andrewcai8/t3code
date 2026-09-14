import { useEffect, useEffectEvent } from "react";

import { allProvisionedSandboxes, forgetProvisionedSandbox } from "./provisionedSandboxLeases";
import { drainProvisionCancellations, subscribeProvisionCancellations } from "./provisionRequests";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export function ProvisionedSandboxLeaseHeartbeat() {
  const touch = useAtomCommand(serverEnvironment.touchProvisionedEnvironment, {
    reportFailure: false,
  });

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

  useEffect(() => {
    const touchAll = () => {
      for (const lease of allProvisionedSandboxes()) {
        void touch({
          environmentId: lease.managerEnvironmentId,
          input: { leaseId: lease.leaseId },
        });
      }
    };
    touchAll();
    const interval = globalThis.setInterval(touchAll, HEARTBEAT_INTERVAL_MS);
    return () => globalThis.clearInterval(interval);
  }, [touch]);

  return null;
}
