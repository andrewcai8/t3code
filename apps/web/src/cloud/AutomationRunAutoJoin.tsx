import {
  automationEnvironmentsToJoin,
  recordAutomationJoinFailure,
  type AutomationJoinFailure,
} from "@t3tools/client-runtime/cloud";
import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { useProvisionedEnvironmentJoin } from "../connection/useProvisionedEnvironmentJoin";
import { useVisibleInterval } from "../hooks/useVisibleInterval";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { resolveThreadRouteRef } from "../threadRoutes";
import { automationJoins, useAutomationHosts } from "./automationHosts";
import { provisionedSandboxFor, rememberProvisionedSandbox } from "./provisionedSandboxLeases";

const JOIN_POLL_MS = 60_000;
/** Per session, so a host whose connection flaps does not reset the backoff. */
const joinFailures = new Map<string, AutomationJoinFailure>();

/**
 * Joins the environments hosts start for automation runs, so each run's chat shows in the
 * sidebar. A joined box is left to idle until the user opens its chat, which hands its lease to
 * the heartbeat. It never navigates.
 */
export function AutomationRunAutoJoin() {
  const hosts = useAutomationHosts();
  const openedThread = resolveThreadRouteRef(useParams({ strict: false }));
  const openedEnvironmentId = openedThread?.environmentId;
  const openedThreadId = openedThread?.threadId;

  useEffect(() => {
    if (!openedEnvironmentId || !openedThreadId) return;
    const joined = automationJoins
      .joined()
      .find(
        (join) => join.environmentId === openedEnvironmentId && join.threadId === openedThreadId,
      );
    if (!joined) return;
    const ref = { environmentId: joined.environmentId, threadId: joined.threadId };
    if (provisionedSandboxFor(ref) !== null) return;
    rememberProvisionedSandbox(ref, {
      leaseId: joined.leaseId,
      sandboxId: joined.sandboxId,
      managerEnvironmentId: joined.managerEnvironmentId,
    });
  }, [openedEnvironmentId, openedThreadId]);

  return hosts.map((host) => (
    <HostAutomationRunAutoJoin key={host.environmentId} managerId={host.environmentId} />
  ));
}

function HostAutomationRunAutoJoin({ managerId }: { managerId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(
    serverEnvironment.joinableAutomationEnvironments({ environmentId: managerId, input: {} }),
  );
  const { join } = useProvisionedEnvironmentJoin(managerId);
  const joining = useRef(false);
  useVisibleInterval(query.refresh, JOIN_POLL_MS, true);

  const joinNewRuns = useEffectEvent(
    async (joinable: ReadonlyArray<DiscoveredProvisionedEnvironment>) => {
      if (joining.current) return;
      joining.current = true;
      try {
        const selected = automationEnvironmentsToJoin(joinable, {
          now: Date.now(),
          known: new Set(environments.map((environment) => environment.environmentId)),
          joined: new Set(automationJoins.joined().map((joined) => joined.requestId)),
          failures: joinFailures,
        });
        // One at a time: each join may resume a box and pair a new connection.
        for (const environment of selected) {
          try {
            await join(environment, (_, ref, lease) => {
              if (ref === null) return;
              automationJoins.record({ requestId: environment.requestId, ...ref, ...lease });
            });
            joinFailures.delete(environment.requestId);
          } catch (error) {
            joinFailures.set(
              environment.requestId,
              recordAutomationJoinFailure(joinFailures.get(environment.requestId), Date.now()),
            );
            console.warn("[automations] could not join a run's environment", {
              requestId: environment.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        joining.current = false;
      }
    },
  );
  useEffect(() => {
    if (query.data) void joinNewRuns(query.data);
  }, [query.data]);

  return null;
}
