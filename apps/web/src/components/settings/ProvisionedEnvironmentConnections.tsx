import { describeCloudCleanup } from "@t3tools/client-runtime/cloud";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { forgetProvisionedSandbox } from "../../cloud/provisionedSandboxLeases";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ensureLocalApi } from "../../localApi";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

const LIFECYCLE_LABELS: Record<DiscoveredProvisionedEnvironment["lifecycle"], string> = {
  active: "Running",
  paused: "Paused",
  missing: "Lost",
  disposed: "Deleted",
};

/**
 * One cloud machine the host runs for a chat. Its chat opens it, when that chat is on this
 * device; here it can only be woken, kept from cleanup, or deleted.
 */
function ProvisionedEnvironmentRow({
  environment,
  busy,
  onResume,
  onKeep,
  onDelete,
}: {
  environment: DiscoveredProvisionedEnvironment;
  busy: boolean;
  onResume: () => void;
  onKeep: (keep: boolean) => void;
  onDelete: (title: string) => void;
}) {
  // The minute clock is UTC without its zone.
  const now = Date.parse(`${useNowMinute()}Z`);
  const cleanup = describeCloudCleanup(environment.cleanup, now);
  const threadRef =
    environment.threadId === null
      ? null
      : scopeThreadRef(environment.environmentId, environment.threadId);
  const thread = useThreadShell(threadRef);
  const navigate = useNavigate();
  const title = thread?.title ?? environment.label;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm">{title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {environment.repository ?? environment.projectDir} ·{" "}
          {environment.provider === "e2b" ? "E2B" : "Namespace"} ·{" "}
          {LIFECYCLE_LABELS[environment.lifecycle]}
          {cleanup ? ` · ${cleanup.text}` : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {environment.lifecycle === "paused" ? (
          <Button size="xs" variant="outline" disabled={busy} onClick={onResume}>
            Resume
          </Button>
        ) : null}
        {cleanup?.action ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onKeep(cleanup.action === "keep")}
          >
            {cleanup.action === "keep" ? "Keep" : "Allow cleanup"}
          </Button>
        ) : null}
        {thread !== null && threadRef !== null ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => void navigate({ to: "/$environmentId/$threadId", params: threadRef })}
          >
            Open chat
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={busy}
          onClick={() => onDelete(title)}
        >
          Delete
        </Button>
      </div>
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
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const dispose = useAtomCommand(serverEnvironment.disposeProvisionedEnvironment, {
    reportFailure: false,
  });
  const keep = useAtomCommand(serverEnvironment.keepProvisionedEnvironment, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = query.refresh;
  useEffect(() => {
    if (!supported) return;
    refresh();
    const timer = globalThis.setInterval(refresh, 15_000);
    return () => globalThis.clearInterval(timer);
  }, [supported, refresh]);

  async function act(
    environment: DiscoveredProvisionedEnvironment,
    action: () => Promise<string | null>,
  ) {
    setBusy(environment.requestId);
    setMessage(null);
    try {
      setMessage(await action());
    } finally {
      setBusy(null);
      refresh();
    }
  }
  const resumeEnvironment = (environment: DiscoveredProvisionedEnvironment) =>
    act(environment, async () => {
      const result = await resume({
        environmentId: managerId,
        input: { environmentId: environment.environmentId },
      });
      if (result._tag === "Failure") return "The host could not resume this machine. Try again.";
      return result.value.kind === "resumed" ? null : result.value.message;
    });
  const keepEnvironment = (environment: DiscoveredProvisionedEnvironment, kept: boolean) =>
    act(environment, async () => {
      const result = await keep({
        environmentId: managerId,
        input: { requestId: environment.requestId, keep: kept },
      });
      if (result._tag === "Failure") return "The host could not update this machine. Try again.";
      return result.value.kind === "updated" ? null : result.value.message;
    });
  const deleteEnvironment = async (
    environment: DiscoveredProvisionedEnvironment,
    title: string,
  ) => {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      [
        `Delete the cloud machine for "${title}"?`,
        "This permanently stops it and ends any running work. The chat's history stays.",
      ].join("\n"),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    await act(environment, async () => {
      const result = await dispose({
        environmentId: managerId,
        input: { requestId: environment.requestId },
      });
      if (result._tag === "Failure") return "The host could not delete this machine. Try again.";
      if (result.value.kind !== "disposed") return "The host could not delete this machine.";
      if (environment.threadId !== null)
        forgetProvisionedSandbox(scopeThreadRef(environment.environmentId, environment.threadId));
      return null;
    });
  };

  if (!supported || (!query.error && !query.data?.length)) return null;
  return (
    <div className="space-y-3 border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Cloud machines · {managerLabel}
          {query.data ? ` (${query.data.length})` : ""}
        </p>
        <Button size="xs" variant="outline" disabled={query.isPending} onClick={query.refresh}>
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p className="text-xs text-destructive">
          Cloud machines could not be loaded. Refresh to try again.
        </p>
      ) : null}
      {query.data?.map((environment) => (
        <ProvisionedEnvironmentRow
          key={environment.requestId}
          environment={environment}
          busy={busy === environment.requestId}
          onResume={() => void resumeEnvironment(environment)}
          onKeep={(kept) => void keepEnvironment(environment, kept)}
          onDelete={(title) => void deleteEnvironment(environment, title)}
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
