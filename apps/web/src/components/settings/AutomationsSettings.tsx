import { isOffDeviceReachablePairingUrl } from "@t3tools/client-runtime/connection";
import { offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import {
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  type Automation,
  type AutomationRun,
  type AutomationSaveResult,
  type EnvironmentId,
  type ProvisionProvider,
  type ServerConfig,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MoreVertical, PlusIcon } from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState, type ReactNode } from "react";

import { useAutomationHosts } from "../../cloud/automationHosts";
import { useProvisionedEnvironmentJoin } from "../../connection/useProvisionedEnvironmentJoin";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useVisibleInterval } from "../../hooks/useVisibleInterval";
import {
  cloudProviderEntries,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
} from "../../providerInstances";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { formatRelativeTimeLabel } from "../../timestampFormat";
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
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  automationDraftFrom,
  automationInputFromDraft,
  automationTriggerLabel,
  automationWebhookUrl,
  isAutomationRunActive,
  newAutomationDraft,
  type AutomationDraft,
  type AutomationDraftField,
} from "./AutomationsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** The account menu's value for "run on the account with the most usage left". */
const MOST_USAGE_LEFT = "most-usage-left";
const PROVIDER_LABELS: Record<ProvisionProvider, string> = { e2b: "E2B", namespace: "Mac" };
const TRIGGER_LABELS: Record<AutomationRun["trigger"], string> = {
  cron: "Schedule",
  webhook: "Webhook",
  manual: "Run now",
};
const RUN_STATE_LABELS: Record<AutomationRun["state"], string> = {
  provisioning: "Starting a box",
  attaching: "Connecting",
  starting: "Starting the chat",
  started: "Started",
  failed: "Failed",
  skipped: "Skipped",
};
const RUN_POLL_MS = 5_000;

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function AutomationsSettings() {
  const managers = useAutomationHosts().flatMap(({ environmentId, label, serverConfig }) =>
    serverConfig ? [{ environmentId, label, serverConfig }] : [],
  );
  return (
    <SettingsPageContainer>
      {managers.length === 0 ? (
        <SettingsSection id="automations" title="Automations">
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Automations need a connected host with cloud environments configured.
          </p>
        </SettingsSection>
      ) : (
        managers.map((manager, index) => (
          <ManagerAutomations
            key={manager.environmentId}
            sectionId={index === 0 ? "automations" : undefined}
            managerId={manager.environmentId}
            title={managers.length > 1 ? `Automations · ${manager.label}` : "Automations"}
            config={manager.serverConfig}
          />
        ))
      )}
    </SettingsPageContainer>
  );
}

type Editing = { readonly kind: "create" } | { readonly kind: "edit"; automation: Automation };

function ManagerAutomations({
  sectionId,
  managerId,
  title,
  config,
}: {
  sectionId: string | undefined;
  managerId: EnvironmentId;
  title: string;
  config: ServerConfig;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.automations({ environmentId: managerId, input: {} }),
  );
  const managerHttpBaseUrl = useEnvironmentHttpBaseUrl(managerId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; url: string } | null>(null);
  const reveal = (result: AutomationSaveResult) => {
    if (result.webhookToken === null) return;
    setRevealed({
      name: result.automation.name,
      url: managerHttpBaseUrl
        ? automationWebhookUrl(managerHttpBaseUrl, result.webhookToken)
        : `${AUTOMATION_WEBHOOK_PATH_PREFIX}/${result.webhookToken}`,
    });
  };
  return (
    <SettingsSection
      id={sectionId}
      title={title}
      headerAction={
        <Button size="xs" variant="outline" onClick={() => setEditing({ kind: "create" })}>
          <PlusIcon className="size-3.5" /> New automation
        </Button>
      }
    >
      {query.error ? (
        <p className="px-4 py-3 text-sm text-destructive">{query.error}</p>
      ) : query.data === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading automations…</p>
      ) : query.data.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No automations yet. Each run opens a chat in your sidebar.
        </p>
      ) : (
        query.data.map((automation) => (
          <AutomationRow
            key={automation.id}
            managerId={managerId}
            automation={automation}
            onEdit={() => setEditing({ kind: "edit", automation })}
            onWebhookMinted={reveal}
          />
        ))
      )}
      {editing ? (
        <AutomationEditor
          key={editing.kind === "edit" ? editing.automation.id : "new"}
          managerId={managerId}
          config={config}
          automation={editing.kind === "edit" ? editing.automation : null}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setEditing(null);
            reveal(result);
          }}
        />
      ) : null}
      {revealed ? <WebhookLinkDialog {...revealed} onClose={() => setRevealed(null)} /> : null}
    </SettingsSection>
  );
}

function AutomationRow({
  managerId,
  automation,
  onEdit,
  onWebhookMinted,
}: {
  managerId: EnvironmentId;
  automation: Automation;
  onEdit: () => void;
  onWebhookMinted: (result: AutomationSaveResult) => void;
}) {
  const runNow = useAtomCommand(serverEnvironment.runAutomationNow, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteAutomation, { reportFailure: false });
  const rotate = useAtomCommand(serverEnvironment.rotateAutomationWebhook, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const target = { environmentId: managerId, input: { id: automation.id } };
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
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            {automation.name}
            {automation.enabled ? null : (
              <span className="ml-2 text-xs text-muted-foreground">Off</span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {automation.repository}
            {automation.branch ? `@${automation.branch}` : ""} ·{" "}
            {PROVIDER_LABELS[automation.provider]} · {automationTriggerLabel(automation)}
          </p>
        </div>
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
      <AutomationRuns managerId={managerId} automationId={automation.id} />
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
    </div>
  );
}

function AutomationRuns({
  managerId,
  automationId,
}: {
  managerId: EnvironmentId;
  automationId: Automation["id"];
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.recentAutomationRuns({
      environmentId: managerId,
      input: { id: automationId },
    }),
  );
  const runs = query.data ?? [];
  useVisibleInterval(
    query.refresh,
    RUN_POLL_MS,
    runs.some((run) => isAutomationRunActive(run.state)),
  );
  const listProvisioned = useAtomQueryRunner(serverEnvironment.provisionedEnvironments, {
    reportFailure: false,
    refresh: true,
  });
  const { join } = useProvisionedEnvironmentJoin(managerId);
  const navigate = useNavigate();
  const [opening, setOpening] = useState<AutomationRun["id"] | null>(null);

  // A run's chat is reachable only once this device has joined its box, as Connections does.
  async function openChat(run: AutomationRun) {
    setOpening(run.id);
    try {
      const listed = await listProvisioned({ environmentId: managerId, input: {} });
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

  if (query.error) return <p className="mt-2 text-xs text-destructive">{query.error}</p>;
  if (runs.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {runs.map((run) => (
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
          {(run.state === "failed" || run.state === "skipped") && run.error ? (
            <p className={run.state === "failed" ? "break-words text-destructive" : "break-words"}>
              {run.error}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AutomationEditor({
  managerId,
  config,
  automation,
  onClose,
  onSaved,
}: {
  managerId: EnvironmentId;
  config: ServerConfig;
  automation: Automation | null;
  onClose: () => void;
  onSaved: (result: AutomationSaveResult) => void;
}) {
  const create = useAtomCommand(serverEnvironment.createAutomation, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateAutomation, { reportFailure: false });
  const providerEntries = useMemo(
    () => deriveProviderInstanceEntries(config.providers),
    [config.providers],
  );
  const agents = useMemo(() => cloudProviderEntries(providerEntries), [providerEntries]);
  const places = offeredProvisionProviders(config);
  const [draft, setDraft] = useState<AutomationDraft>(() =>
    automation
      ? automationDraftFrom(automation, browserTimeZone())
      : newAutomationDraft({
          agentDriver: agents[0]?.driverKind ?? "",
          provider: places[0] ?? "",
          timeZone: browserTimeZone(),
        }),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const accounts = providerEntries.filter(
    (entry) => entry.driverKind === draft.agentDriver && isProviderInstancePickerVisible(entry),
  );
  const parsed = automationInputFromDraft(draft);
  const errors = parsed.kind === "invalid" ? parsed.errors : {};
  // Schedule mistakes show while typing; the rest wait for a save attempt.
  const errorFor = (field: AutomationDraftField) =>
    field === "schedule" || submitted ? errors[field] : undefined;
  const set = (patch: Partial<AutomationDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  async function save() {
    setSubmitted(true);
    if (parsed.kind !== "valid") return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = automation
        ? await update({
            environmentId: managerId,
            input: { id: automation.id, automation: parsed.input },
          })
        : await create({ environmentId: managerId, input: parsed.input });
      if (AsyncResult.isSuccess(result)) onSaved(result.value);
      else if (AsyncResult.isFailure(result))
        setSaveError(formatEnvironmentQueryError(result.cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup
        className="max-w-xl"
        showCloseButton={!saving}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{automation ? "Edit automation" : "New automation"}</DialogTitle>
          <DialogDescription>
            Each run starts a cloud box, clones the repository, and opens a chat with this prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <Field label="Name" error={errorFor("name")}>
            <Input
              autoFocus
              value={draft.name}
              disabled={saving}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="Nightly dependency check"
            />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)_10rem] gap-3">
            <Field label="Repository" error={errorFor("repository")}>
              <Input
                value={draft.repository}
                disabled={saving}
                onChange={(event) => set({ repository: event.target.value })}
                placeholder="owner/name"
              />
            </Field>
            <Field label="Branch">
              <Input
                value={draft.branch}
                disabled={saving}
                onChange={(event) => set({ branch: event.target.value })}
                placeholder="Default"
              />
            </Field>
          </div>
          <Field label="Prompt" error={errorFor("prompt")}>
            <Textarea
              value={draft.prompt}
              disabled={saving}
              rows={5}
              onChange={(event) => set({ prompt: event.target.value })}
              placeholder="Look for failing tests on main and open a PR that fixes them."
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Agent" error={errorFor("agentDriver")}>
              <Select
                value={draft.agentDriver}
                disabled={saving}
                onValueChange={(agentDriver) =>
                  set({
                    agentDriver: agentDriver ?? "",
                    account: agentDriver === draft.agentDriver ? draft.account : "",
                  })
                }
              >
                <SelectTrigger size="sm" aria-label="Agent">
                  <SelectValue>
                    {agents.find((entry) => entry.driverKind === draft.agentDriver)?.displayName ??
                      (draft.agentDriver || "Choose")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {agents.map((entry) => (
                    <SelectItem key={entry.driverKind} value={entry.driverKind}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Account">
              <Select
                value={draft.account === "" ? MOST_USAGE_LEFT : draft.account}
                disabled={saving}
                onValueChange={(account) =>
                  set({ account: !account || account === MOST_USAGE_LEFT ? "" : account })
                }
              >
                <SelectTrigger size="sm" aria-label="Account">
                  <SelectValue>
                    {draft.account === ""
                      ? "Most usage left"
                      : (accounts.find((entry) => entry.instanceId === draft.account)
                          ?.displayName ?? draft.account)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={MOST_USAGE_LEFT}>Most usage left</SelectItem>
                  {accounts.map((entry) => (
                    <SelectItem key={entry.instanceId} value={entry.instanceId}>
                      {entry.displayName}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field label="Runs on" error={errorFor("provider")}>
              <Select
                value={draft.provider}
                disabled={saving}
                onValueChange={(provider) => set({ provider: provider ?? "" })}
              >
                <SelectTrigger size="sm" aria-label="Runs on">
                  <SelectValue>
                    {draft.provider === "" ? "Choose" : PROVIDER_LABELS[draft.provider]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {places.map((provider) => (
                    <SelectItem key={provider} value={provider}>
                      {PROVIDER_LABELS[provider]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>
          <div className="space-y-2">
            <ToggleRow
              label="Run on a schedule"
              checked={draft.scheduled}
              disabled={saving}
              onChange={(scheduled) => set({ scheduled })}
            />
            {draft.scheduled ? (
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <Field label="Cron">
                  <Input
                    value={draft.cron}
                    disabled={saving}
                    aria-invalid={errors.schedule !== undefined || undefined}
                    onChange={(event) => set({ cron: event.target.value })}
                    placeholder="0 9 * * 1-5"
                  />
                </Field>
                <Field label="Time zone">
                  <Input
                    value={draft.timeZone}
                    disabled={saving}
                    aria-invalid={errors.schedule !== undefined || undefined}
                    onChange={(event) => set({ timeZone: event.target.value })}
                    placeholder="America/New_York"
                  />
                </Field>
                {errors.schedule ? (
                  <p className="col-span-2 text-xs text-destructive">{errors.schedule}</p>
                ) : null}
              </div>
            ) : null}
            <ToggleRow
              label="Run when the webhook link is called"
              checked={draft.webhook}
              disabled={saving}
              onChange={(webhook) => set({ webhook })}
            />
            <ToggleRow
              label="On"
              checked={draft.enabled}
              disabled={saving}
              onChange={(enabled) => set({ enabled })}
            />
          </div>
          {saveError ? (
            <p role="alert" className="text-xs text-destructive">
              {saveError}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {automation ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block min-w-0 space-y-1.5 text-sm">
      <span>{label}</span>
      {children}
      {error ? <span className="block text-xs text-destructive">{error}</span> : null}
    </label>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

function WebhookLinkDialog({
  name,
  url,
  onClose,
}: {
  name: string;
  url: string;
  onClose: () => void;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy link", description: error.message }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
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
        <DialogPanel className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {url}
            </code>
            <Button size="xs" variant="ghost" onClick={() => copyToClipboard(url, undefined)}>
              {isCopied ? "Copied" : "Copy link"}
            </Button>
          </div>
          {isOffDeviceReachablePairingUrl(url) ? null : (
            <p className="text-xs text-muted-foreground">
              This host is reached through a local address, so only this computer can call the link.
              Connect to the host by its network or tunnel address to get a shareable link.
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
