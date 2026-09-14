import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type DiscoveredProvisionedEnvironment, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { connectPairing } from "../../connection/onboarding";
import { openProvisionedEnvironment } from "../../connection/provisioned";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "../../state/waitForThreadShell";
import { Button } from "../ui/button";

export function ProvisionedEnvironmentRow({
  environment,
  pending,
  disabled,
  onOpen,
}: {
  environment: DiscoveredProvisionedEnvironment;
  pending: boolean;
  disabled: boolean;
  onOpen: () => void;
}) {
  const thread = useThreadShell(
    environment.threadId === null
      ? null
      : scopeThreadRef(environment.environmentId, environment.threadId),
  );
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm">{thread?.title ?? environment.label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {environment.repository ?? environment.projectDir} ·{" "}
          {environment.provider === "e2b" ? "E2B" : "Namespace"}
        </p>
      </div>
      <Button size="xs" variant="outline" disabled={disabled} onClick={onOpen}>
        {pending ? "Connecting…" : environment.threadId === null ? "Connect" : "Open thread"}
      </Button>
    </div>
  );
}

export function ProvisionedEnvironmentConnections({
  managerId,
  managerLabel,
}: {
  managerId: EnvironmentId;
  managerLabel: string;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(managerId))?.environmentControl === true;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.provisionedEnvironments({ environmentId: managerId, input: {} })
      : null,
  );
  const attach = useAtomCommand(serverEnvironment.attachProvisionedEnvironment, {
    reportFailure: false,
  });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = query.refresh;
  useEffect(() => {
    if (!supported) return;
    refresh();
    const timer = globalThis.setInterval(refresh, 15_000);
    return () => globalThis.clearInterval(timer);
  }, [supported, refresh]);
  async function open(environment: DiscoveredProvisionedEnvironment) {
    setPending(environment.requestId);
    setMessage(null);
    try {
      const ref = await openProvisionedEnvironment(environment, {
        isConnected: (id) =>
          environments.some(
            (entry) => entry.environmentId === id && entry.connection.phase === "connected",
          ),
        attach: async () => {
          const result = await attach({
            environmentId: managerId,
            input: { requestId: environment.requestId },
          });
          if (AsyncResult.isFailure(result))
            throw new Error("The manager could not issue a connection. Try again.");
          return result.value;
        },
        pair: async (pairingUrl) => {
          const result = await pair({
            pairingUrl,
            expectedEnvironmentId: environment.environmentId,
          });
          if (AsyncResult.isFailure(result))
            throw new Error("The environment could not be connected. Try again.");
          return result.value;
        },
        waitForThread: waitForThreadShell,
      });
      if (ref) await navigate({ to: "/$environmentId/$threadId", params: ref });
      else setMessage("Environment connected. Its threads will appear when they are available.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The environment could not be opened.");
    } finally {
      setPending(null);
    }
  }
  if (!supported || (!query.error && !query.data?.length)) return null;
  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Provisioned environments · {managerLabel}
          {query.data ? ` (${query.data.length})` : ""}
        </p>
        <Button size="xs" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p className="text-xs text-destructive">
          Provisioned environments could not be loaded. Refresh to try again.
        </p>
      ) : null}
      {query.data?.map((environment) => (
        <ProvisionedEnvironmentRow
          key={environment.requestId}
          environment={environment}
          pending={pending === environment.requestId}
          disabled={pending !== null}
          onOpen={() => void open(environment)}
        />
      ))}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
