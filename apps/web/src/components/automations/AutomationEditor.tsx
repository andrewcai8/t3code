import { offeredProvisionProviders } from "@t3tools/client-runtime/cloud";
import type {
  Automation,
  AutomationSaveResult,
  EnvironmentId,
  ServerConfig,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";

import {
  cloudProviderEntries,
  deriveProviderInstanceEntries,
  isProviderInstancePickerVisible,
} from "../../providerInstances";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { usePaginatedBranches } from "../../state/queries";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
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
import {
  Select,
  SelectButton,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  PROVISION_PROVIDER_LABELS,
  SCHEDULE_PRESET_LABELS,
  automationBranchOptions,
  automationDraftFrom,
  automationInputFromDraft,
  automationRepositoryOptions,
  automationTemplates,
  draftSchedule,
  formatRunTime,
  newAutomationDraft,
  nextRuns,
  withPresetKind,
  type AutomationDraft,
  type AutomationDraftField,
  type AutomationRepositoryOption,
  type SchedulePreset,
  type SchedulePresetKind,
} from "./automations.logic";

/** Select and combobox value for an empty draft field ("the default"), which base-ui treats as unset. */
const DEFAULT_CHOICE = "__default__";
const fromChoice = (value: string | null) => (!value || value === DEFAULT_CHOICE ? "" : value);
const toChoice = (value: string) => (value === "" ? DEFAULT_CHOICE : value);

const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const PRESET_KINDS = Object.keys(SCHEDULE_PRESET_LABELS) as ReadonlyArray<SchedulePresetKind>;
// 2000-01-02 was a Sunday.
const WEEKDAY_NAMES = Array.from({ length: 7 }, (_, weekday) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(
    Date.UTC(2000, 0, 2 + weekday),
  ),
);

export function AutomationEditor({
  hostId,
  config,
  automation,
  onClose,
  onSaved,
}: {
  hostId: EnvironmentId;
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
  const projects = useProjects();
  const repositoryOptions = useMemo(() => automationRepositoryOptions(projects), [projects]);
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
  const agent = agents.find((entry) => entry.driverKind === draft.agentDriver);
  const accounts = providerEntries.filter(
    (entry) => entry.driverKind === draft.agentDriver && isProviderInstancePickerVisible(entry),
  );
  const models = (agent?.models ?? []).filter((model) => !model.isCustom);
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
            environmentId: hostId,
            input: { id: automation.id, automation: parsed.input },
          })
        : await create({ environmentId: hostId, input: parsed.input });
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
        className="max-w-4xl"
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
            Each run starts a cloud machine, clones the repository, and opens a chat with this
            prompt.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="flex min-w-0 flex-col gap-4">
              <Field label="Name" error={errorFor("name")}>
                <Input
                  autoFocus
                  value={draft.name}
                  disabled={saving}
                  onChange={(event) => set({ name: event.target.value })}
                  placeholder="Nightly dependency check"
                />
              </Field>
              <div className="flex flex-wrap gap-1.5">
                {automationTemplates.map((template) => (
                  <Button
                    key={template.name}
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={saving}
                    onClick={() =>
                      set({
                        prompt: template.prompt,
                        name: draft.name.trim() === "" ? template.name : draft.name,
                      })
                    }
                  >
                    {template.name}
                  </Button>
                ))}
              </div>
              <Field label="Prompt" error={errorFor("prompt")}>
                <Textarea
                  value={draft.prompt}
                  disabled={saving}
                  rows={14}
                  onChange={(event) => set({ prompt: event.target.value })}
                  placeholder="Look for failing tests on main and open a PR that fixes them."
                />
              </Field>
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <RepositoryField
                options={repositoryOptions}
                value={draft.repository}
                disabled={saving}
                error={errorFor("repository")}
                onChange={(repository) =>
                  set({ repository, branch: repository === draft.repository ? draft.branch : "" })
                }
              />
              <BranchField
                source={
                  repositoryOptions.find((option) => option.repository === draft.repository)
                    ?.source ?? null
                }
                value={draft.branch}
                disabled={saving}
                error={errorFor("branch")}
                onChange={(branch) => set({ branch })}
              />
              <Field label="Runs on" error={errorFor("provider")}>
                <Select
                  value={draft.provider}
                  disabled={saving}
                  onValueChange={(provider) => set({ provider: provider ?? "" })}
                >
                  <SelectTrigger aria-label="Runs on">
                    <SelectValue>
                      {draft.provider === "" ? "Choose" : PROVISION_PROVIDER_LABELS[draft.provider]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {places.map((provider) => (
                      <SelectItem key={provider} value={provider}>
                        {PROVISION_PROVIDER_LABELS[provider]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Agent" error={errorFor("agentDriver")}>
                <Select
                  value={draft.agentDriver}
                  disabled={saving}
                  onValueChange={(agentDriver) => {
                    if (agentDriver && agentDriver !== draft.agentDriver)
                      set({ agentDriver, account: "", model: "" });
                  }}
                >
                  <SelectTrigger aria-label="Agent">
                    <SelectValue>
                      {agent?.displayName ?? (draft.agentDriver || "Choose")}
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
              <Field label="Account" error={errorFor("account")}>
                <Select
                  value={toChoice(draft.account)}
                  disabled={saving}
                  onValueChange={(account) => set({ account: fromChoice(account) })}
                >
                  <SelectTrigger aria-label="Account">
                    <SelectValue>
                      {draft.account === ""
                        ? "Most usage left"
                        : (accounts.find((entry) => entry.instanceId === draft.account)
                            ?.displayName ?? draft.account)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={DEFAULT_CHOICE}>Most usage left</SelectItem>
                    {accounts.map((entry) => (
                      <SelectItem key={entry.instanceId} value={entry.instanceId}>
                        {entry.displayName}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <Field label="Model" error={errorFor("model")}>
                <Select
                  value={toChoice(draft.model)}
                  disabled={saving}
                  onValueChange={(model) => set({ model: fromChoice(model) })}
                >
                  <SelectTrigger aria-label="Model">
                    <SelectValue>
                      {draft.model === ""
                        ? "Default model"
                        : (models.find((model) => model.slug === draft.model)?.name ?? draft.model)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={DEFAULT_CHOICE}>Default model</SelectItem>
                    {draft.model !== "" && !models.some((model) => model.slug === draft.model) ? (
                      <SelectItem value={draft.model}>{draft.model}</SelectItem>
                    ) : null}
                    {models.map((model) => (
                      <SelectItem key={model.slug} value={model.slug}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
                <ToggleRow
                  label="Schedule"
                  checked={draft.scheduled}
                  disabled={saving}
                  onChange={(scheduled) => set({ scheduled })}
                />
                {draft.scheduled ? (
                  <ScheduleFields
                    draft={draft}
                    disabled={saving}
                    error={errors.schedule}
                    onChange={set}
                  />
                ) : null}
                <ToggleRow
                  label="Webhook"
                  checked={draft.webhook}
                  disabled={saving}
                  onChange={(webhook) => set({ webhook })}
                />
                {draft.webhook ? (
                  <p className="-mt-1.5 text-xs text-muted-foreground">
                    {automation?.webhook
                      ? "The link stays the same. Rotate it from the automation's menu."
                      : "The link is shown once, after you save."}
                  </p>
                ) : null}
                <ToggleRow
                  label="On"
                  checked={draft.enabled}
                  disabled={saving}
                  onChange={(enabled) => set({ enabled })}
                />
              </div>
            </div>
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

function RepositoryField({
  options,
  value,
  disabled,
  error,
  onChange,
}: {
  options: ReadonlyArray<AutomationRepositoryOption>;
  value: string;
  disabled: boolean;
  error: string | undefined;
  onChange: (repository: string) => void;
}) {
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const repositories = options.map((option) => option.repository);
    // An edited automation keeps its repository even when no project here clones it.
    return value === "" || repositories.includes(value) ? repositories : [value, ...repositories];
  }, [options, value]);
  const labels = new Map(options.map((option) => [option.repository, option.label]));
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? items
      : items.filter(
          (item) =>
            item.toLowerCase().includes(needle) || labels.get(item)?.toLowerCase().includes(needle),
        );
  return (
    <Field label="Repository" error={error}>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Add the project in T3 Code to pick its repository.
        </p>
      ) : (
        <PickerCombobox
          ariaLabel="Repository"
          items={items}
          filteredItems={filtered}
          value={value}
          disabled={disabled}
          placeholder="Search repositories…"
          emptyText="No matching repositories."
          query={query}
          onQueryChange={setQuery}
          onSelect={onChange}
          renderTrigger={() => value || "Choose a repository"}
          renderItem={(item) => (
            <>
              <span className="min-w-0 flex-1 truncate">{item}</span>
              {labels.has(item) ? (
                <span className="shrink-0 truncate text-xs text-muted-foreground">
                  {labels.get(item)}
                </span>
              ) : null}
            </>
          )}
        />
      )}
    </Field>
  );
}

function BranchField({
  source,
  value,
  disabled,
  error,
  onChange,
}: {
  source: AutomationRepositoryOption["source"] | null;
  value: string;
  disabled: boolean;
  error: string | undefined;
  onChange: (branch: string) => void;
}) {
  const { environments } = useEnvironments();
  const connected =
    source !== null &&
    environments.some(
      (environment) =>
        environment.environmentId === source.environmentId &&
        environment.connection.phase === "connected",
    );
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const { refs } = usePaginatedBranches(
    connected
      ? { environmentId: source.environmentId, cwd: source.cwd, query: deferredQuery }
      : { environmentId: null, cwd: null },
  );
  const { defaultBranch, branches } = automationBranchOptions(refs, value);
  const defaultLabel = defaultBranch ? `Default branch (${defaultBranch})` : "Default branch";
  const items = [DEFAULT_CHOICE, ...branches];
  return (
    <Field label="Branch" error={error}>
      <PickerCombobox
        ariaLabel="Branch"
        items={items}
        filteredItems={items}
        value={toChoice(value)}
        disabled={disabled}
        placeholder="Search branches…"
        emptyText="No matching branches."
        query={query}
        onQueryChange={setQuery}
        onSelect={(branch) => onChange(fromChoice(branch))}
        renderTrigger={() => (value === "" ? defaultLabel : value)}
        renderItem={(item) => (
          <span className="min-w-0 flex-1 truncate">
            {item === DEFAULT_CHOICE ? defaultLabel : item}
          </span>
        )}
      />
    </Field>
  );
}

/** A searchable single-choice picker over string values, styled like a select. */
function PickerCombobox({
  ariaLabel,
  items,
  filteredItems,
  value,
  disabled,
  placeholder,
  emptyText,
  query,
  onQueryChange,
  onSelect,
  renderTrigger,
  renderItem,
}: {
  ariaLabel: string;
  items: ReadonlyArray<string>;
  filteredItems: ReadonlyArray<string>;
  value: string;
  disabled: boolean;
  placeholder: string;
  emptyText: string;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (value: string) => void;
  renderTrigger: () => ReactNode;
  renderItem: (item: string) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onQueryChange("");
      }}
      value={value}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        setOpen(false);
        onSelect(next);
      }}
    >
      <ComboboxTrigger aria-label={ariaLabel} render={<SelectButton className="w-full" />}>
        {renderTrigger()}
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="flex w-(--anchor-width) min-w-64 flex-col">
        <ComboboxSearchInput
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {renderItem(item)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

function ScheduleFields({
  draft,
  disabled,
  error,
  onChange,
}: {
  draft: AutomationDraft;
  disabled: boolean;
  error: string | undefined;
  onChange: (patch: Partial<AutomationDraft>) => void;
}) {
  const preset = draft.schedule;
  const setPreset = (schedule: SchedulePreset) => onChange({ schedule });
  const { cron, timeZone } = draftSchedule(draft);
  const nowMinute = useNowMinute();
  const upcoming = useMemo(
    () =>
      error === undefined
        ? nextRuns({ cron, timeZone }, Date.parse(`${nowMinute}Z`), 3).map((date) =>
            formatRunTime(date),
          )
        : [],
    [error, cron, timeZone, nowMinute],
  );
  return (
    <div className="flex flex-col gap-3">
      <Select
        value={preset.kind}
        disabled={disabled}
        onValueChange={(kind) => {
          if (kind) setPreset(withPresetKind(preset, kind as SchedulePresetKind));
        }}
      >
        <SelectTrigger aria-label="Repeat">
          <SelectValue>{SCHEDULE_PRESET_LABELS[preset.kind]}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {PRESET_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind}>
              {SCHEDULE_PRESET_LABELS[kind]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {preset.kind === "hourly" ? (
        <Field label="Minute past the hour">
          <Input
            type="number"
            nativeInput
            min={0}
            max={59}
            value={preset.minute}
            disabled={disabled}
            onChange={(event) => {
              const minute = Number(event.target.value);
              if (Number.isInteger(minute) && minute >= 0 && minute <= 59)
                setPreset({ ...preset, minute });
            }}
          />
        </Field>
      ) : null}
      {preset.kind === "weekly" ? (
        <Select
          value={String(preset.weekday)}
          disabled={disabled}
          onValueChange={(weekday) => {
            if (weekday !== null) setPreset({ ...preset, weekday: Number(weekday) });
          }}
        >
          <SelectTrigger aria-label="Day of the week">
            <SelectValue>{WEEKDAY_NAMES[preset.weekday]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {WEEKDAY_NAMES.map((name, weekday) => (
              <SelectItem key={name} value={String(weekday)}>
                {name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {preset.kind === "daily" || preset.kind === "weekdays" || preset.kind === "weekly" ? (
        <Field label="Time">
          <Input
            type="time"
            nativeInput
            value={`${twoDigits(preset.hour)}:${twoDigits(preset.minute)}`}
            disabled={disabled}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(":").map(Number);
              if (hour !== undefined && minute !== undefined && !Number.isNaN(hour + minute))
                setPreset({ ...preset, hour, minute });
            }}
          />
        </Field>
      ) : null}
      {preset.kind === "custom" ? (
        <Field label="Cron">
          <Input
            value={preset.cron}
            disabled={disabled}
            aria-invalid={error !== undefined || undefined}
            onChange={(event) => setPreset({ kind: "custom", cron: event.target.value })}
            placeholder="0 9 * * 1-5"
          />
        </Field>
      ) : null}
      <Field label="Time zone">
        <Input
          value={draft.timeZone}
          disabled={disabled}
          aria-invalid={error !== undefined || undefined}
          onChange={(event) => onChange({ timeZone: event.target.value })}
          placeholder="America/New_York"
        />
      </Field>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : upcoming.length > 0 ? (
        <div className="text-xs text-muted-foreground">
          <p>Next runs</p>
          <ul className="mt-1 space-y-0.5 text-foreground">
            {upcoming.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
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
