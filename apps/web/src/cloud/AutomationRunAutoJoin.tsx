import {
  automationEnvironmentsToJoin,
  createAutomationJoinAttempts,
} from "@t3tools/client-runtime/cloud";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useProvisionedEnvironmentJoin } from "../connection/useProvisionedEnvironmentJoin";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { localProvisionStorage } from "./provisionStorage";

const DISCOVERY_INTERVAL_MS = 60_000;
const automationJoinAttempts = createAutomationJoinAttempts(localProvisionStorage);

/**
 * Joins the environments hosts start for automation runs, so each run's chat shows in the
 * sidebar without anyone opening it from Settings. It never navigates.
 */
export function AutomationRunAutoJoin() {
  const { environments } = useEnvironments();
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environmentControl === true,
    )
    .map((manager) => (
      <ManagerAutomationRunAutoJoin key={manager.environmentId} managerId={manager.environmentId} />
    ));
}

function ManagerAutomationRunAutoJoin({ managerId }: { managerId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(
    serverEnvironment.provisionedEnvironments({ environmentId: managerId, input: {} }),
  );
  const { join } = useProvisionedEnvironmentJoin(managerId);
  const refresh = query.refresh;
  useEffect(() => {
    const timer = globalThis.setInterval(refresh, DISCOVERY_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [refresh]);

  const joinNewRuns = useEffectEvent(() => {
    const selected = automationEnvironmentsToJoin(
      query.data ?? [],
      new Set(environments.map((environment) => environment.environmentId)),
      automationJoinAttempts.attempted(),
    );
    for (const environment of selected) {
      // Recorded first, so a join that fails or that the user later undoes is never repeated.
      // Without a record there is no such guarantee, so storage that refuses it skips the join.
      try {
        automationJoinAttempts.record(environment.requestId);
      } catch {
        return;
      }
      join(environment).catch((error: unknown) => {
        console.warn("[automations] could not join a run's environment", {
          requestId: environment.requestId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });
  useEffect(() => {
    if (query.data) joinNewRuns();
  }, [query.data]);

  return null;
}
