import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function CloudComputeControls({
  managerId,
  managerLabel,
  onStarted,
}: {
  managerId: EnvironmentId;
  managerLabel: string;
  onStarted: (id: EnvironmentId) => boolean;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(managerId))?.environmentControl === true;
  const query = useEnvironmentQuery(
    supported
      ? serverEnvironment.managedEnvironments({ environmentId: managerId, input: {} })
      : null,
  );
  const start = useAtomCommand(serverEnvironment.startManagedEnvironment, { reportFailure: false });
  const stop = useAtomCommand(serverEnvironment.stopManagedEnvironment, { reportFailure: false });
  const [pending, setPending] = useState<EnvironmentId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function act(environmentId: EnvironmentId, action: "start" | "stop") {
    setPending(environmentId);
    setMessage(null);
    try {
      const result = await (action === "start" ? start : stop)({
        environmentId: managerId,
        input: { environmentId },
      });
      if (AsyncResult.isFailure(result))
        setMessage("Compute command failed. Refresh to check the provider state.");
      else if (result.value.kind === "refused") setMessage(result.value.message);
      else if (action === "start" && !onStarted(environmentId))
        setMessage(
          "Started. Choose this environment in T3 Connect or pair with it to connect this device.",
        );
    } finally {
      setPending(null);
    }
  }
  if (!query.error && !query.data?.length) return null;
  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Cloud compute managed by {managerLabel}</p>
        <Button
          size="xs"
          variant="outline"
          disabled={query.isPending || pending !== null}
          onClick={query.refresh}
        >
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p className="text-xs text-destructive">
          Cloud controls unavailable. The manager must be connected and configured.
        </p>
      ) : null}
      {query.data?.map((environment) => (
        <div key={environment.environmentId} className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm">{environment.label}</p>
            <p className="text-xs text-muted-foreground">
              Compute:{" "}
              {environment.state.kind === "unavailable"
                ? environment.state.message
                : environment.state.kind}
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            disabled={pending !== null || environment.state.kind === "unavailable"}
            onClick={() =>
              void act(
                environment.environmentId,
                environment.state.kind === "running" ? "stop" : "start",
              )
            }
          >
            {pending === environment.environmentId
              ? "Working…"
              : environment.state.kind === "running"
                ? "Stop"
                : "Start"}
          </Button>
        </div>
      ))}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </div>
  );
}
