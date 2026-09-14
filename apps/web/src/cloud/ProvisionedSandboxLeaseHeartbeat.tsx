import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent } from "react";

import {
  forgetProvisionedSandbox,
  provisionedSandboxForEnvironment,
} from "./provisionedSandboxLeases";
import { drainProvisionCancellations, subscribeProvisionCancellations } from "./provisionRequests";
import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export function ProvisionedSandboxLeaseHeartbeat() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const touch = useAtomCommand(serverEnvironment.touchProvisionedEnvironment, {
    reportFailure: false,
  });
  const markMissing = useAtomCommand(environmentCatalog.markWorkspaceMissing);

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
    let cancelled = false;
    const touchAll = () => {
      for (const [environmentId, entry] of catalog.entries) {
        if (
          entry.target._tag === "BearerConnectionTarget" &&
          entry.target.workspaceStatus === "missing"
        )
          continue;
        const owned = provisionedSandboxForEnvironment(environmentId);
        if (!owned) continue;
        void touch({
          environmentId: owned.lease.managerEnvironmentId,
          input: { leaseId: owned.lease.leaseId },
        }).then(async (result) => {
          if (
            !cancelled &&
            provisionedSandboxForEnvironment(environmentId)?.lease === owned.lease &&
            result._tag === "Success" &&
            result.value.kind === "refused" &&
            result.value.reason === "missing"
          )
            await markMissing(environmentId);
        });
      }
    };
    touchAll();
    const interval = globalThis.setInterval(touchAll, HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      globalThis.clearInterval(interval);
    };
  }, [catalog.entries, markMissing, touch]);

  return null;
}
