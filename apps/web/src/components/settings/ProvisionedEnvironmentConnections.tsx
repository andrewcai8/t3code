import {
  isOffDeviceReachablePairingUrl,
  provisionedGatewayPairingUrl,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type DiscoveredProvisionedEnvironment, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useId, useState } from "react";
import { connectPairing } from "../../connection/onboarding";
import { openProvisionedEnvironment } from "../../connection/provisioned";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentHttpBaseUrl, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShell } from "../../state/waitForThreadShell";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import { toastManager } from "../ui/toast";

type DevicePairing =
  | { readonly kind: "minting" }
  | { readonly kind: "shareable"; readonly url: string }
  | { readonly kind: "local-only" }
  | { readonly kind: "failed"; readonly message: string };

function ProvisionedEnvironmentRow({
  environment,
  pending,
  disabled,
  onOpen,
  onMintPairingUrl,
}: {
  environment: DiscoveredProvisionedEnvironment;
  pending: boolean;
  disabled: boolean;
  onOpen: () => void;
  onMintPairingUrl: () => Promise<string>;
}) {
  const thread = useThreadShell(
    environment.threadId === null
      ? null
      : scopeThreadRef(environment.environmentId, environment.threadId),
  );
  const [pairing, setPairing] = useState<DevicePairing | null>(null);
  const pairingPanelId = useId();
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () => {
      toastManager.add({
        type: "success",
        title: "Pairing link copied",
        description: "Open it on the device you want to pair to this machine.",
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy pairing link",
        description: error.message,
      });
    },
  });
  // Each open mints again rather than reusing the last URL, since a stale link may already be spent.
  async function togglePairing() {
    if (pairing !== null) {
      setPairing(null);
      return;
    }
    setPairing({ kind: "minting" });
    try {
      const url = await onMintPairingUrl();
      setPairing(
        isOffDeviceReachablePairingUrl(url) ? { kind: "shareable", url } : { kind: "local-only" },
      );
    } catch (error) {
      setPairing({
        kind: "failed",
        message:
          error instanceof Error
            ? error.message
            : "The manager could not issue a pairing link. Try again.",
      });
    }
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm">{thread?.title ?? environment.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {environment.repository ?? environment.projectDir} ·{" "}
            {environment.provider === "e2b" ? "E2B" : "Namespace"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            aria-expanded={pairing !== null}
            aria-controls={pairingPanelId}
            disabled={pairing?.kind === "minting"}
            onClick={() => void togglePairing()}
          >
            Pair device
          </Button>
          <Button size="xs" variant="outline" disabled={disabled} onClick={onOpen}>
            {pending ? "Connecting…" : environment.threadId === null ? "Connect" : "Open thread"}
          </Button>
        </div>
      </div>
      {pairing !== null ? (
        <div id={pairingPanelId} className="mt-3 border-t border-border/50 pt-3">
          {pairing.kind === "minting" ? (
            <p className="text-xs text-muted-foreground">Creating a pairing link…</p>
          ) : pairing.kind === "local-only" ? (
            <p className="text-xs text-muted-foreground">
              This machine is reachable only through this computer. Another device cannot use a
              pairing link for it.
            </p>
          ) : pairing.kind === "failed" ? (
            <p className="text-xs text-destructive">{pairing.message}</p>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Scan on the device you want to pair. Anyone with this link can control this
                  machine.
                </p>
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                    {pairing.url}
                  </code>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => copyToClipboard(pairing.url, undefined)}
                  >
                    Copy link
                  </Button>
                </div>
              </div>
              <div className="w-fit shrink-0 rounded-xl bg-white p-3">
                <QRCodeSvg
                  value={pairing.url}
                  size={168}
                  level="M"
                  marginSize={1}
                  title="Pairing link — scan to open on another device"
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
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
  const resume = useAtomCommand(serverEnvironment.resumeProvisionedEnvironment, {
    reportFailure: false,
  });
  const resumeUnclaimed = useAtomCommand(serverEnvironment.resumeUnclaimedProvisionedEnvironment, {
    reportFailure: false,
  });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const { environments } = useEnvironments();
  const managerHttpBaseUrl = useEnvironmentHttpBaseUrl(managerId);
  const rewritePairingUrl = (pairingUrl: string, leaseId: string) =>
    managerHttpBaseUrl
      ? provisionedGatewayPairingUrl(managerHttpBaseUrl, leaseId, pairingUrl)
      : pairingUrl;
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
  const requestAttach = (environment: DiscoveredProvisionedEnvironment) =>
    attach({
      environmentId: managerId,
      input: { requestId: environment.requestId },
    });
  async function attachForClient(environment: DiscoveredProvisionedEnvironment) {
    if (environment.lifecycle === "paused") {
      const resumed =
        environment.threadId === null
          ? await resumeUnclaimed({
              environmentId: managerId,
              input: {
                leaseId: environment.leaseId,
                sandboxId: environment.sandboxId,
                environmentId: environment.environmentId,
              },
            })
          : await resume({
              environmentId: managerId,
              input: {
                leaseId: environment.leaseId,
                sandboxId: environment.sandboxId,
                environmentId: environment.environmentId,
                threadId: environment.threadId,
              },
            });
      if (AsyncResult.isFailure(resumed))
        throw new Error("The manager could not resume this environment. Try again.");
      if (resumed.value.kind === "refused") throw new Error(resumed.value.message);
    }
    const result = await requestAttach(environment);
    if (AsyncResult.isFailure(result))
      throw new Error("The manager could not issue a connection. Try again.");
    if (result.value.kind === "refused") throw new Error(result.value.message);
    return result.value;
  }
  async function mintPairingUrl(environment: DiscoveredProvisionedEnvironment): Promise<string> {
    const result = await attachForClient(environment);
    return rewritePairingUrl(result.pairingUrl, environment.leaseId);
  }
  async function open(environment: DiscoveredProvisionedEnvironment) {
    setPending(environment.requestId);
    setMessage(null);
    try {
      const ref = await openProvisionedEnvironment(environment, {
        isConnected: (id) =>
          environments.some(
            (entry) => entry.environmentId === id && entry.connection.phase === "connected",
          ),
        attach: () => attachForClient(environment),
        pair: async (pairingUrl) => {
          const result = await pair({
            pairingUrl,
            expectedEnvironmentId: environment.environmentId,
          });
          if (AsyncResult.isFailure(result))
            throw new Error("The environment could not be connected. Try again.");
          return result.value;
        },
        rewritePairingUrl: (pairingUrl, lease) => rewritePairingUrl(pairingUrl, lease.leaseId),
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
          onMintPairingUrl={() => mintPairingUrl(environment)}
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
