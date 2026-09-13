import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext } from "react";
import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "../state/server";
import { createProvisionedEnvironmentRecovery } from "./provisionedEnvironmentRecovery";

const recoveries = new WeakMap<
  React.ContextType<typeof RegistryContext>,
  ReturnType<typeof createProvisionedEnvironmentRecovery>
>();

export function useProvisionedEnvironmentRecovery() {
  const registry = useContext(RegistryContext);
  let recovery = recoveries.get(registry);
  if (!recovery) {
    recovery = createProvisionedEnvironmentRecovery({
      resume: async ({ lease, threadRef }) => {
        const result = await runAtomCommand(
          registry,
          serverEnvironment.resumeProvisionedEnvironment,
          {
            environmentId: lease.managerEnvironmentId,
            input: { leaseId: lease.leaseId, sandboxId: lease.sandboxId, ...threadRef },
          },
          { reportFailure: false },
        );
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (result.value.kind === "refused") throw new Error(result.value.message);
      },
      retry: async (environmentId) => {
        const result = await runAtomCommand(registry, environmentCatalog.retryNow, environmentId, {
          reportFailure: false,
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      },
      awaitConnected: async (environmentId) => {
        const result = await runAtomCommand(
          registry,
          environmentCatalog.awaitConnected,
          environmentId,
          { reportFailure: false },
        );
        if (result._tag === "Failure")
          throw new Error("The workspace connection is not ready. Retry shortly.");
      },
    });
    recoveries.set(registry, recovery);
  }
  return recovery;
}
