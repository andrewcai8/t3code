import { useEffect } from "react";

import { allProvisionedSandboxes } from "./provisionedSandboxLeases";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export function ProvisionedSandboxLeaseHeartbeat() {
  const touch = useAtomCommand(serverEnvironment.touchProvisionedEnvironment, {
    reportFailure: false,
  });

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
