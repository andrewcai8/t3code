import {
  automationEnvironmentsToJoin,
  automationJoinsToDrop,
  recordAutomationJoinFailure,
  type AutomationJoinFailure,
} from "@t3tools/client-runtime/cloud";
import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useEffectEvent, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useProvisionedEnvironmentJoin } from "../connection/useProvisionedEnvironmentJoin";
import { useVisibleInterval } from "../hooks/useVisibleInterval";
import { useEnvironments } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveThreadRouteRef } from "../threadRoutes";
import { automationJoins, useAutomationHosts } from "./automationHosts";
import { provisionedSandboxFor, rememberProvisionedSandbox } from "./provisionedSandboxLeases";

const JOIN_POLL_MS = 60_000;
/** Per session, so a host whose connection flaps does not reset the backoff. */
const joinFailures = new Map<string, AutomationJoinFailure>();

/**
 * Joins the environments hosts start for automation runs, so each run's chat shows in the
 * sidebar. A joined box is left to idle until the user opens its chat, which hands its lease to
 * the heartbeat. Joined runs nobody opened are disconnected once they leave the host's list or
 * exceed the cap. It never navigates.
 */
export function AutomationRunAutoJoin() {
  const hosts = useAutomationHosts();
  const openedThread = resolveThreadRouteRef(useParams({ strict: false }));
  // Read when a join lands, which may be after the user already navigated to its chat.
  const opened = useRef(openedThread);
  opened.current = openedThread;
  const touch = useAtomCommand(serverEnvironment.touchProvisionedEnvironment, {
    reportFailure: false,
  });

  const promoteOpenedChat = useCallback(() => {
    const route = opened.current;
    if (!route) return;
    const joined = automationJoins
      .joined()
      .find(
        (join) => join.environmentId === route.environmentId && join.threadId === route.threadId,
      );
    if (!joined) return;
    const ref = { environmentId: joined.environmentId, threadId: joined.threadId };
    if (provisionedSandboxFor(ref) !== null) return;
    const lease = {
      leaseId: joined.leaseId,
      sandboxId: joined.sandboxId,
      managerEnvironmentId: joined.managerEnvironmentId,
    };
    rememberProvisionedSandbox(ref, lease);
    // The heartbeat's next tick can be minutes away; renew now so the box does not idle out.
    void touch({ environmentId: lease.managerEnvironmentId, input: { leaseId: lease.leaseId } });
  }, [touch]);
  const openedEnvironmentId = openedThread?.environmentId;
  const openedThreadId = openedThread?.threadId;
  useEffect(promoteOpenedChat, [openedEnvironmentId, openedThreadId, promoteOpenedChat]);

  return hosts.map((host) => (
    <HostAutomationRunAutoJoin
      key={host.environmentId}
      managerId={host.environmentId}
      onJoined={promoteOpenedChat}
    />
  ));
}

function HostAutomationRunAutoJoin({
  managerId,
  onJoined,
}: {
  managerId: EnvironmentId;
  onJoined: () => void;
}) {
  const { environments } = useEnvironments();
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
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
        const joins = automationJoins.joined();
        const known = new Set(environments.map((environment) => environment.environmentId));
        const selected = automationEnvironmentsToJoin(joinable, {
          now: Date.now(),
          known,
          joined: new Set(joins.map((joined) => joined.requestId)),
          failures: joinFailures,
        });
        const drops = automationJoinsToDrop(joins, {
          managerId,
          joinable,
          known,
          opened: new Set(
            joins
              .filter((joined) => provisionedSandboxFor(joined) !== null)
              .map((joined) => joined.requestId),
          ),
          incoming: selected.length,
        });
        // The joined record keeps each dropped run, so it is not joined again.
        for (const dropped of drops) {
          const removed = await removeEnvironment(dropped.environmentId);
          if (AsyncResult.isFailure(removed))
            console.warn("[automations] could not disconnect an unopened run", {
              requestId: dropped.requestId,
            });
        }
        // One at a time: each join may resume a box and pair a new connection.
        for (const environment of selected) {
          try {
            await join(environment, (_, ref, lease) => {
              if (ref === null) return;
              automationJoins.record({ requestId: environment.requestId, ...ref, ...lease });
              onJoined();
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
