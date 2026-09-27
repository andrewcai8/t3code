import { isOffDeviceReachablePairingUrl } from "@t3tools/client-runtime/connection";
import {
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  type Automation,
  type AutomationRun,
  type AutomationSaveResult,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MoreVertical, PlusIcon } from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { useAutomationHosts } from "../../cloud/automationHosts";
import { useProvisionedEnvironmentJoin } from "../../connection/useProvisionedEnvironmentJoin";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useVisibleInterval } from "../../hooks/useVisibleInterval";
import { cloudProviderEntries, deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AutomationEditor } from "./AutomationEditor";
import {
  PROVISION_PROVIDER_LABELS,
  automationInputOf,
  automationTriggerSummary,
  automationWebhookUrl,
  formatRunTime,
  formatTimeUntil,
  isAutomationRunActive,
  nextRuns,
} from "./automations.logic";

const TRIGGER_LABELS: Record<AutomationRun["trigger"], string> = {
  cron: "Schedule",
  webhook: "Webhook",
  manual: "Run now",
};
const RUN_STATE_LABELS: Record<AutomationRun["state"], string> = {
  provisioning: "Starting a machine",
  attaching: "Connecting",
  starting: "Starting the chat",
  started: "Started",
  failed: "Failed",
  skipped: "Skipped",
};
const RUN_POLL_MS = 5_000;
const COLLAPSED_RUNS = 3;

interface Host {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: ServerConfig;
}

type Editing = {
  readonly host: Host;
  readonly automation: Automation | null;
};

export function AutomationsPage() {
  const hosts: ReadonlyArray<Host> = useAutomationHosts().flatMap(
    ({ environmentId, label, serverConfig }) =>
      serverConfig ? [{ environmentId, label, serverConfig }] : [],
  );
  const [editing, setEditing] = useState<Editing | null>(null);
  const [revealed, setRevealed] = useState<{
    hostId: EnvironmentId;
    name: string;
    token: string;
  } | null>(null);
  const reveal = (hostId: EnvironmentId, result: AutomationSaveResult) => {
    if (result.webhookToken === null) return;
    setRevealed({ hostId, name: result.automation.name, token: result.webhookToken });
  };
  const onlyHost = hosts.length === 1 ? hosts[0] : undefined;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Automations">
            <WorkspaceBreadcrumbItem current>
              <h1>Automations</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer className="max-w-3xl">
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                Each run starts a cloud machine, clones the repository, and opens a chat with your
                prompt.
              </p>
              {onlyHost ? (
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => setEditing({ host: onlyHost, automation: null })}
                >
                  <PlusIcon className="size-3.5" /> New automation
                </Button>
              ) : null}
            </div>
            {hosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Connect to a host that offers cloud machines to see and create automations.
              </p>
            ) : (
              hosts.map((host) => (
                <HostAutomations
                  key={host.environmentId}
                  host={host}
                  showHeading={hosts.length > 1}
                  onNew={() => setEditing({ host, automation: null })}
                  onEdit={(automation) => setEditing({ host, automation })}
                  onWebhookMinted={(result) => reveal(host.environmentId, result)}
                />
              ))
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {editing ? (
        <AutomationEditor
          key={editing.automation?.id ?? "new"}
          hostId={editing.host.environmentId}
          config={editing.host.serverConfig}
          automation={editing.automation}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            reveal(editing.host.environmentId, result);
          }}
        />
      ) : null}
      {revealed ? <WebhookLinkDialog {...revealed} onClose={() => setRevealed(null)} /> : null}
    </SidebarInset>
  );
}

function HostAutomations({
  host,
  showHeading,
  onNew,
  onEdit,
  onWebhookMinted,
}: {
  host: Host;
  showHeading: boolean;
  onNew: () => void;
  onEdit: (automation: Automation) => void;
  onWebhookMinted: (result: AutomationSaveResult) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.automations({ environmentId: host.environmentId, input: {} }),
  );
  const agents = useMemo(
    () => cloudProviderEntries(deriveProviderInstanceEntries(host.serverConfig.providers)),
    [host.serverConfig.providers],
  );
  return (
    <section className="flex flex-col gap-3">
      {showHeading ? (
        <div className="flex items-center justify-between gap-4">
          <h2 className="truncate text-sm text-foreground/70">{host.label}</h2>
          <Button size="xs" variant="outline" onClick={onNew}>
            <PlusIcon className="size-3.5" /> New automation
          </Button>
        </div>
      ) : null}
      {query.error ? (
        <p className="text-sm text-destructive">{query.error}</p>
      ) : query.data === null ? (
        <p className="text-sm text-muted-foreground">Loading automations…</p>
      ) : query.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No automations yet. Each run opens a chat in your sidebar.
        </p>
      ) : (
        query.data.map((automation) => {
          const agent = agents.find((entry) => entry.driverKind === automation.agentDriver);
          return (
            <AutomationCard
              key={automation.id}
              hostId={host.environmentId}
              automation={automation}
              agentName={agent?.displayName ?? automation.agentDriver}
              modelName={
                automation.model === null
                  ? null
                  : (agent?.models.find((model) => model.slug === automation.model)?.name ??
                    automation.model)
              }
              onEdit={() => onEdit(automation)}
              onWebhookMinted={onWebhookMinted}
            />
          );
        })
      )}
    </section>
  );
}

function AutomationCard({
  hostId,
  automation,
  agentName,
  modelName,
  onEdit,
  onWebhookMinted,
}: {
  hostId: EnvironmentId;
  automation: Automation;
  agentName: string;
  modelName: string | null;
  onEdit: () => void;
  onWebhookMinted: (result: AutomationSaveResult) => void;
}) {
  const runNow = useAtomCommand(serverEnvironment.runAutomationNow, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateAutomation, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteAutomation, { reportFailure: false });
  const rotate = useAtomCommand(serverEnvironment.rotateAutomationWebhook, {
    reportFailure: false,
  });
  const runsQuery = useEnvironmentQuery(
    serverEnvironment.recentAutomationRuns({ environmentId: hostId, input: { id: automation.id } }),
  );
  const runs = runsQuery.data ?? [];
  useVisibleInterval(
    runsQuery.refresh,
    RUN_POLL_MS,
    runs.some((run) => isAutomationRunActive(run.state)),
  );
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const target = { environmentId: hostId, input: { id: automation.id } };
  // The shared minute clock keeps "Next run" moving on without a timer of its own.
  const nowMinute = useNowMinute();
  const nextRun = useMemo(() => {
    if (!automation.enabled || automation.schedule === null) return null;
    const now = Date.parse(`${nowMinute}Z`);
    const [next] = nextRuns(automation.schedule, now, 1);
    return next ? `${formatTimeUntil(next, now)}, ${formatRunTime(next)}` : null;
  }, [automation.enabled, automation.schedule, nowMinute]);
  const lastRun = runs[0];

  async function perform<A, E>(
    failureTitle: string,
    run: () => Promise<AsyncResult.AsyncResult<A, E>>,
    onSuccess?: (value: A) => void,
  ) {
    setBusy(true);
    try {
      const result = await run();
      if (AsyncResult.isSuccess(result)) onSuccess?.(result.value);
      else if (AsyncResult.isFailure(result))
        toastManager.add({
          type: "error",
          title: failureTitle,
          description: formatEnvironmentQueryError(result.cause),
        });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-xl border border-border/70 bg-card px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{automation.name}</h3>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {automation.repository}
            {automation.branch ? `@${automation.branch}` : ""}
          </p>
        </div>
        <Switch
          className="mt-0.5"
          aria-label={`${automation.name} on`}
          checked={automation.enabled}
          disabled={busy}
          onCheckedChange={(enabled) =>
            void perform(
              enabled ? "Could not turn the automation on" : "Could not turn the automation off",
              () =>
                update({
                  environmentId: hostId,
                  input: {
                    id: automation.id,
                    automation: automationInputOf(automation, { enabled }),
                  },
                }),
            )
          }
        />
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void perform("Could not start a run", () => runNow(target))}
        >
          Run now
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                disabled={busy}
                aria-label={`${automation.name} options`}
              />
            }
          >
            <MoreVertical />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={onEdit}>Edit</MenuItem>
            {automation.webhook ? (
              <MenuItem
                onClick={() =>
                  void perform(
                    "Could not rotate the webhook link",
                    () => rotate(target),
                    onWebhookMinted,
                  )
                }
              >
                Rotate webhook link
              </MenuItem>
            ) : null}
            <MenuItem variant="destructive" onClick={() => setConfirmingDelete(true)}>
              Delete
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Runs on</dt>
        <dd className="truncate">
          {PROVISION_PROVIDER_LABELS[automation.provider]} · {agentName}
          {modelName ? ` · ${modelName}` : ""}
        </dd>
        <dt className="text-muted-foreground">Trigger</dt>
        <dd className="truncate">{automationTriggerSummary(automation)}</dd>
        {nextRun ? (
          <>
            <dt className="text-muted-foreground">Next run</dt>
            <dd className="truncate">{nextRun}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Last run</dt>
        <dd className={cn("truncate", lastRun?.state === "failed" && "text-destructive")}>
          {lastRun
            ? `${RUN_STATE_LABELS[lastRun.state]} · ${formatRelativeTimeLabel(lastRun.createdAt)}`
            : "Not run yet"}
        </dd>
      </dl>
      {runsQuery.error ? (
        <p className="mt-2 text-xs text-destructive">{runsQuery.error}</p>
      ) : (
        <AutomationRuns hostId={hostId} runs={runs} />
      )}
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {automation.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It stops running and its webhook link stops working. Chats it already opened stay in
              your sidebar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmingDelete(false);
                void perform("Could not delete the automation", () => remove(target));
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </article>
  );
}

function AutomationRuns({
  hostId,
  runs,
}: {
  hostId: EnvironmentId;
  runs: ReadonlyArray<AutomationRun>;
}) {
  const listProvisioned = useAtomQueryRunner(serverEnvironment.provisionedEnvironments, {
    reportFailure: false,
    refresh: true,
  });
  const { join } = useProvisionedEnvironmentJoin(hostId);
  const navigate = useNavigate();
  const [opening, setOpening] = useState<AutomationRun["id"] | null>(null);
  const [expanded, setExpanded] = useState(false);

  // A run's chat is reachable only once this device has joined its box, as Connections does.
  async function openChat(run: AutomationRun) {
    setOpening(run.id);
    try {
      const listed = await listProvisioned({ environmentId: hostId, input: {} });
      if (!AsyncResult.isSuccess(listed)) throw new Error("Could not reach the host. Try again.");
      const environment = listed.value.find((entry) => entry.requestId === run.requestId);
      if (!environment) throw new Error("This run's box no longer exists.");
      const ref = await join(environment);
      if (ref) await navigate({ to: "/$environmentId/$threadId", params: ref });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open the chat",
        description: error instanceof Error ? error.message : "The chat could not be opened.",
      });
    } finally {
      setOpening(null);
    }
  }

  if (runs.length === 0) return null;
  const shown = expanded ? runs : runs.slice(0, COLLAPSED_RUNS);
  return (
    <div className="mt-3 border-t border-border/60 pt-2.5">
      <ul className="space-y-1">
        {shown.map((run) => (
          <li key={run.id} className="text-xs text-muted-foreground">
            <div className="flex items-baseline gap-2">
              <span>{TRIGGER_LABELS[run.trigger]}</span>
              <span>{formatRelativeTimeLabel(run.createdAt)}</span>
              <span className={run.state === "failed" ? "text-destructive" : undefined}>
                {RUN_STATE_LABELS[run.state]}
              </span>
              {run.threadId !== null ? (
                <button
                  type="button"
                  className="text-foreground underline-offset-2 hover:underline disabled:opacity-50"
                  disabled={opening !== null}
                  onClick={() => void openChat(run)}
                >
                  {opening === run.id ? "Opening…" : "Open chat"}
                </button>
              ) : null}
            </div>
            {run.error ? (
              <p
                className={run.state === "failed" ? "break-words text-destructive" : "break-words"}
              >
                {run.error}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {runs.length > COLLAPSED_RUNS ? (
        <button
          type="button"
          className="mt-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show fewer" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

function WebhookLinkDialog({
  hostId,
  name,
  token,
  onClose,
}: {
  hostId: EnvironmentId;
  name: string;
  token: string;
  onClose: () => void;
}) {
  const managerHttpBaseUrl = useEnvironmentHttpBaseUrl(hostId);
  const [copied, setCopied] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => setCopied(true),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  const url = managerHttpBaseUrl ? automationWebhookUrl(managerHttpBaseUrl, token) : null;
  const path = `${AUTOMATION_WEBHOOK_PATH_PREFIX}/${encodeURIComponent(token)}`;
  // The token is shown once, so leaving before copying it must be deliberate.
  const requestClose = () => (copied ? onClose() : setConfirmingClose(true));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Webhook link for {name}</DialogTitle>
          <DialogDescription>
            Copy it now. It will not be shown again. POST to it to start a run; anyone with the link
            can.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-2">
            {url === null ? (
              <p className="text-xs text-muted-foreground">
                This client does not know the host&apos;s web address, so it cannot show the full
                link. Put the host&apos;s address in front of this path.
              </p>
            ) : null}
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
              {url === null ? <span className="text-xs text-muted-foreground">Path</span> : null}
              <code className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                {url ?? path}
              </code>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => copyToClipboard(url ?? path, undefined)}
              >
                {isCopied ? "Copied" : url === null ? "Copy path" : "Copy link"}
              </Button>
            </div>
            {url !== null && !isOffDeviceReachablePairingUrl(url) ? (
              <p className="text-xs text-muted-foreground">
                This host is reached through a local address, so only this computer can call the
                link. Connect to the host by its network or tunnel address to get a shareable link.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {confirmingClose ? (
            <>
              <p className="mr-auto self-center text-xs text-muted-foreground">
                Close without copying? The link will not be shown again.
              </p>
              <Button variant="outline" onClick={() => setConfirmingClose(false)}>
                Keep open
              </Button>
              <Button variant="destructive" onClick={onClose}>
                Close
              </Button>
            </>
          ) : (
            <Button onClick={requestClose}>Done</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
