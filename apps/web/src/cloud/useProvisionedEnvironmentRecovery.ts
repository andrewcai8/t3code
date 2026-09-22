import { RegistryContext } from "@effect/atom-react";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useContext } from "react";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
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
      managers: (environmentId) =>
        [...registry.get(environmentPresentations.presentationsAtom)]
          .filter(
            ([managerId, presentation]) =>
              managerId !== environmentId &&
              presentation.connection.phase === "connected" &&
              presentation.serverConfig?.environmentControl === true,
          )
          .map(([managerId]) => managerId),
      resume: async (managerId, environmentId) => {
        const result = await runAtomCommand(
          registry,
          serverEnvironment.resumeProvisionedEnvironment,
          { environmentId: managerId, input: { environmentId } },
          { reportFailure: false },
        );
        return result._tag === "Failure" ? null : result.value;
      },
      markMissing: async (environmentId) => {
        const marked = await runAtomCommand(
          registry,
          environmentCatalog.markWorkspaceMissing,
          environmentId,
        );
        if (marked._tag === "Failure") throw squashAtomCommandFailure(marked);
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
          throw new Error(
            "The workspace restarted, but the connection is not ready. Retry shortly.",
          );
      },
    });
    recoveries.set(registry, recovery);
  }
  return recovery;
}
