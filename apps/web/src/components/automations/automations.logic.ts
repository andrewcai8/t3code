import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  AutomationInput,
  cloneRepository,
  parseAutomationCron,
  type Automation,
  type AutomationRunState,
  type AutomationSchedule,
  type EnvironmentId,
  type ProvisionProvider,
  type VcsRef,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** A schedule as the editor offers it. Anything that is not one of the named shapes is `custom`. */
export type SchedulePreset =
  | { readonly kind: "hourly"; readonly minute: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekdays"; readonly hour: number; readonly minute: number }
  | {
      readonly kind: "weekly";
      /** 0 is Sunday. */
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    }
  | { readonly kind: "custom"; readonly cron: string };
export type SchedulePresetKind = SchedulePreset["kind"];

export const SCHEDULE_PRESET_LABELS: Record<SchedulePresetKind, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Weekdays",
  weekly: "Every week",
  custom: "Custom cron",
};

export const PROVISION_PROVIDER_LABELS: Record<ProvisionProvider, string> = {
  e2b: "E2B",
  namespace: "Mac",
};

/** The editable form of an automation. Empty strings mean "not chosen yet" or "the default". */
export interface AutomationDraft {
  readonly name: string;
  readonly repository: string;
  /** Empty clones the repository's default branch. */
  readonly branch: string;
  readonly prompt: string;
  readonly agentDriver: string;
  /** Empty runs each time on the account with the most usage left. */
  readonly account: string;
  /** Empty uses the agent's default model. */
  readonly model: string;
  readonly provider: ProvisionProvider | "";
  readonly scheduled: boolean;
  readonly schedule: SchedulePreset;
  readonly timeZone: string;
  readonly webhook: boolean;
  readonly enabled: boolean;
}

/** A field the form can show an error under. */
export type AutomationDraftField = Exclude<keyof AutomationInput, "webhook" | "enabled">;

export type AutomationDraftResult =
  | { readonly kind: "valid"; readonly input: AutomationInput }
  | {
      readonly kind: "invalid";
      readonly errors: Partial<Record<AutomationDraftField, string>>;
    };

export const automationTemplates: ReadonlyArray<{
  readonly name: string;
  readonly prompt: string;
}> = [
  {
    name: "Fix lint errors",
    prompt:
      "/poteto-mode Fix the open lint errors in this repository, open a PR, and land it via the merge queue.",
  },
  {
    name: "Triage failing CI",
    prompt:
      "/poteto-mode Triage the failing CI on the default branch, ship a fix in a PR, and land it via the merge queue.",
  },
  {
    name: "Update dependencies",
    prompt:
      "/poteto-mode Update outdated dependencies, fix anything the update breaks, open a PR, and land it via the merge queue.",
  },
];

const DEFAULT_SCHEDULE: SchedulePreset = { kind: "weekdays", hour: 9, minute: 0 };

export function presetCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case "hourly":
      return `${preset.minute} * * * *`;
    case "daily":
      return `${preset.minute} ${preset.hour} * * *`;
    case "weekdays":
      return `${preset.minute} ${preset.hour} * * 1-5`;
    case "weekly":
      return `${preset.minute} ${preset.hour} * * ${preset.weekday}`;
    case "custom":
      return preset.cron.trim();
  }
}

/** A plain number within `max`, written the way `presetCron` writes it so the round trip is exact. */
function cronNumber(field: string, max: number): number | null {
  if (!/^(0|[1-9]\d?)$/.test(field)) return null;
  const value = Number(field);
  return value <= max ? value : null;
}

export function presetFromCron(cron: string): SchedulePreset {
  const custom = { kind: "custom", cron: cron.trim() } as const;
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return custom;
  const [minuteField, hourField, dayOfMonth, month, weekdayField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = cronNumber(minuteField, 59);
  if (minute === null || dayOfMonth !== "*" || month !== "*") return custom;
  if (hourField === "*") return weekdayField === "*" ? { kind: "hourly", minute } : custom;
  const hour = cronNumber(hourField, 23);
  if (hour === null) return custom;
  if (weekdayField === "*") return { kind: "daily", hour, minute };
  if (weekdayField === "1-5") return { kind: "weekdays", hour, minute };
  const weekday = cronNumber(weekdayField, 6);
  return weekday === null ? custom : { kind: "weekly", weekday, hour, minute };
}

/** Switches the preset's kind, keeping the time of day it had and writing custom out as cron. */
export function withPresetKind(preset: SchedulePreset, kind: SchedulePresetKind): SchedulePreset {
  if (kind === preset.kind) return preset;
  if (kind === "custom") return { kind, cron: presetCron(preset) };
  const minute = preset.kind === "custom" ? 0 : preset.minute;
  const hour = preset.kind === "custom" || preset.kind === "hourly" ? 9 : preset.hour;
  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "daily":
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, weekday: preset.kind === "weekly" ? preset.weekday : 1, hour, minute };
  }
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * The next `count` firings after `from`. A step `Cron.next` cannot take (around a DST change)
 * skips an hour ahead, as the host's scheduler does.
 */
export function nextRuns(schedule: AutomationSchedule, from: number, count: number): Date[] {
  const cron = parseAutomationCron(schedule.cron, schedule.timeZone);
  if (cron === null) return [];
  const runs: Date[] = [];
  let cursor = from;
  for (let step = 0; runs.length < count && step < count + 48; step++) {
    try {
      const next = Cron.next(cron, cursor);
      runs.push(next);
      cursor = next.getTime();
    } catch {
      cursor += HOUR_MS;
    }
  }
  return runs;
}

interface FormatOptions {
  readonly locale?: string | undefined;
  /** The zone the viewer reads times in. Defaults to the runtime's zone. */
  readonly timeZone?: string | undefined;
}

const viewerTimeZone = (options: FormatOptions) =>
  options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

function timeOfDay(hour: number, minute: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, hour, minute));
}

/** A short summary such as "Weekdays at 9:00 AM", naming the zone only when it is not the viewer's. */
export function describeSchedule(
  schedule: AutomationSchedule,
  options: FormatOptions = {},
): string {
  const preset = presetFromCron(schedule.cron);
  const at = (hour: number, minute: number) => timeOfDay(hour, minute, options.locale);
  const summary = (() => {
    switch (preset.kind) {
      case "hourly":
        return `Every hour at :${String(preset.minute).padStart(2, "0")}`;
      case "daily":
        return `Every day at ${at(preset.hour, preset.minute)}`;
      case "weekdays":
        return `Weekdays at ${at(preset.hour, preset.minute)}`;
      case "weekly": {
        // 2000-01-02 was a Sunday.
        const weekday = new Intl.DateTimeFormat(options.locale, {
          weekday: "long",
          timeZone: "UTC",
        }).format(Date.UTC(2000, 0, 2 + preset.weekday));
        return `Every ${weekday} at ${at(preset.hour, preset.minute)}`;
      }
      case "custom":
        return preset.cron;
    }
  })();
  return schedule.timeZone === viewerTimeZone(options)
    ? summary
    : `${summary} (${schedule.timeZone})`;
}

export function automationTriggerSummary(
  automation: Pick<Automation, "schedule" | "webhook">,
  options: FormatOptions = {},
): string {
  const parts = [
    ...(automation.schedule ? [describeSchedule(automation.schedule, options)] : []),
    ...(automation.webhook ? ["Webhook"] : []),
  ];
  return parts.length === 0 ? "Run now only" : parts.join(" · ");
}

/** A firing time in the viewer's zone, such as "Mon, Sep 28, 9:00 AM". */
export function formatRunTime(date: Date, options: FormatOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: viewerTimeZone(options),
  }).format(date);
}

/** How far off a future time is, such as "in 3 hours" or "tomorrow". */
export function formatTimeUntil(date: Date, now: number, locale?: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minutes = Math.max(1, Math.round((date.getTime() - now) / 60_000));
  if (minutes < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export interface AutomationRepositoryOption {
  /** `owner/name`, what a cloud machine clones. */
  readonly repository: string;
  /** The project's title, which reads better than a fork's upstream display name. */
  readonly label: string;
  /** A checkout of the repository, for looking up its branches. */
  readonly source: { readonly environmentId: EnvironmentId; readonly cwd: string };
}

/** One option per repository a cloud machine can clone, across every environment's projects. */
export function automationRepositoryOptions(
  projects: ReadonlyArray<
    Pick<EnvironmentProject, "environmentId" | "title" | "workspaceRoot" | "repositoryIdentity">
  >,
): ReadonlyArray<AutomationRepositoryOption> {
  const options = new Map<string, AutomationRepositoryOption>();
  for (const project of projects) {
    const repository = cloneRepository(project.repositoryIdentity);
    if (repository === undefined || options.has(repository)) continue;
    options.set(repository, {
      repository,
      label: project.title,
      source: { environmentId: project.environmentId, cwd: project.workspaceRoot },
    });
  }
  return [...options.values()].sort((left, right) =>
    left.repository.localeCompare(right.repository),
  );
}

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/** A row in the repository picker: a project's repository, or an `owner/name` typed in. */
export type RepositoryChoice =
  | { readonly kind: "typed"; readonly repository: string }
  | { readonly kind: "option"; readonly repository: string; readonly label: string | null };

/**
 * The repository picker's rows for `query`: the projects' repositories that match it, plus
 * `current` when no project clones it, led by the query itself when it is an `owner/name` not
 * listed yet.
 */
export function repositoryChoices(
  options: ReadonlyArray<AutomationRepositoryOption>,
  query: string,
  current: string,
): ReadonlyArray<RepositoryChoice> {
  const listed: Array<RepositoryChoice> = options.map((option) => ({
    kind: "option",
    repository: option.repository,
    label: option.label,
  }));
  if (current !== "" && !options.some((option) => option.repository === current))
    listed.unshift({ kind: "option", repository: current, label: null });
  const typed = query.trim();
  const needle = typed.toLowerCase();
  const matching = listed.filter(
    (choice) =>
      choice.repository.toLowerCase().includes(needle) ||
      (choice.kind === "option" && choice.label?.toLowerCase().includes(needle)),
  );
  const isNew =
    REPOSITORY_PATTERN.test(typed) &&
    !listed.some((choice) => choice.repository.toLowerCase() === needle);
  return isNew ? [{ kind: "typed", repository: typed }, ...matching] : matching;
}

/**
 * The branches a cloud machine can check out, as named on the remote: local branches and remote
 * ones without their remote prefix, once each. `keep` stays listed, as an edited automation's
 * branch must be even when this checkout does not have it.
 */
export function automationBranchOptions(
  refs: ReadonlyArray<VcsRef>,
  keep: string,
): { readonly defaultBranch: string | null; readonly branches: ReadonlyArray<string> } {
  const names = new Set<string>();
  let defaultBranch: string | null = null;
  for (const ref of refs) {
    const name =
      ref.isRemote && ref.remoteName && ref.name.startsWith(`${ref.remoteName}/`)
        ? ref.name.slice(ref.remoteName.length + 1)
        : ref.name;
    if (name === "HEAD") continue;
    if (ref.isDefault) defaultBranch ??= name;
    names.add(name);
  }
  if (keep !== "") names.add(keep);
  return { defaultBranch, branches: [...names].sort((left, right) => left.localeCompare(right)) };
}

/** What an update sends to keep everything about `automation` but the fields in `patch`. */
export function automationInputOf(
  automation: Automation,
  patch: Partial<AutomationInput> = {},
): AutomationInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = automation;
  return { ...input, ...patch };
}

const decodeAutomationInput = Schema.decodeUnknownSync(AutomationInput);
/** Each form field's own wire decoder, so a rule only the schema knows lands under its field. */
const DRAFT_FIELD_DECODERS: Record<
  AutomationDraftField,
  (input: unknown) => Result.Result<unknown, Schema.SchemaError>
> = {
  name: Schema.decodeUnknownResult(AutomationInput.fields.name),
  repository: Schema.decodeUnknownResult(AutomationInput.fields.repository),
  branch: Schema.decodeUnknownResult(AutomationInput.fields.branch),
  prompt: Schema.decodeUnknownResult(AutomationInput.fields.prompt),
  agentDriver: Schema.decodeUnknownResult(AutomationInput.fields.agentDriver),
  account: Schema.decodeUnknownResult(AutomationInput.fields.account),
  model: Schema.decodeUnknownResult(AutomationInput.fields.model),
  provider: Schema.decodeUnknownResult(AutomationInput.fields.provider),
  schedule: Schema.decodeUnknownResult(AutomationInput.fields.schedule),
};
const DRAFT_FIELDS = Object.keys(DRAFT_FIELD_DECODERS) as ReadonlyArray<AutomationDraftField>;

export function newAutomationDraft(defaults: {
  readonly agentDriver: string;
  readonly provider: ProvisionProvider | "";
  readonly timeZone: string;
}): AutomationDraft {
  return {
    name: "",
    repository: "",
    branch: "",
    prompt: "",
    agentDriver: defaults.agentDriver,
    account: "",
    model: "",
    provider: defaults.provider,
    scheduled: false,
    schedule: DEFAULT_SCHEDULE,
    timeZone: defaults.timeZone,
    webhook: false,
    enabled: true,
  };
}

export function automationDraftFrom(automation: Automation, timeZone: string): AutomationDraft {
  return {
    name: automation.name,
    repository: automation.repository,
    branch: automation.branch ?? "",
    prompt: automation.prompt,
    agentDriver: automation.agentDriver,
    account: automation.account ?? "",
    model: automation.model ?? "",
    provider: automation.provider,
    scheduled: automation.schedule !== null,
    schedule: automation.schedule ? presetFromCron(automation.schedule.cron) : DEFAULT_SCHEDULE,
    timeZone: automation.schedule?.timeZone ?? timeZone,
    webhook: automation.webhook,
    enabled: automation.enabled,
  };
}

/** The draft's schedule as the wire would carry it, whether or not it is valid yet. */
export function draftSchedule(draft: AutomationDraft): AutomationSchedule {
  return { cron: presetCron(draft.schedule), timeZone: draft.timeZone.trim() };
}

/**
 * Checks each field with a message written for the form, then decodes every other field on its
 * own at the wire schema, so a rule only the schema knows (such as the schedule's minimum
 * interval) shows under the field it is about.
 */
export function automationInputFromDraft(draft: AutomationDraft): AutomationDraftResult {
  const errors: Partial<Record<AutomationDraftField, string>> = {};
  const name = draft.name.trim();
  const repository = draft.repository.trim();
  const schedule = draftSchedule(draft);
  if (name.length === 0) errors.name = "Name the automation.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";
  if (repository === "") errors.repository = "Choose a repository.";
  else if (!REPOSITORY_PATTERN.test(repository)) errors.repository = "Use owner/name.";
  if (draft.prompt.trim().length === 0) errors.prompt = "Write what the agent should do.";
  else if (draft.prompt.trim().length > 20_000)
    errors.prompt = "Keep the prompt under 20,000 characters.";
  if (draft.agentDriver === "") errors.agentDriver = "Choose an agent.";
  if (draft.provider === "") errors.provider = "Choose where it runs.";
  if (draft.scheduled && parseAutomationCron(schedule.cron, schedule.timeZone) === null)
    errors.schedule = "Use five cron fields, such as 0 9 * * 1-5, and an IANA time zone.";
  const candidate = {
    name,
    repository,
    branch: draft.branch.trim() || null,
    prompt: draft.prompt,
    agentDriver: draft.agentDriver,
    account: draft.account || null,
    model: draft.model || null,
    provider: draft.provider,
    schedule: draft.scheduled ? schedule : null,
    webhook: draft.webhook,
    enabled: draft.enabled,
  };
  for (const field of DRAFT_FIELDS) {
    if (errors[field] !== undefined) continue;
    const decoded = DRAFT_FIELD_DECODERS[field](candidate[field]);
    if (Result.isFailure(decoded)) errors[field] = decoded.failure.message;
  }
  if (Object.keys(errors).length > 0) return { kind: "invalid", errors };
  // Every field decoded on its own and the struct adds no rule of its own, so this cannot throw.
  return { kind: "valid", input: decodeAutomationInput(candidate) };
}

/** The link a caller POSTs to. The token is the whole credential. */
export function automationWebhookUrl(managerHttpBaseUrl: string, token: string): string {
  const base = new URL(managerHttpBaseUrl);
  const prefix = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  base.pathname = `${prefix}${AUTOMATION_WEBHOOK_PATH_PREFIX}/${encodeURIComponent(token)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

/** A run still on its way to `started` or `failed`. */
export function isAutomationRunActive(state: AutomationRunState): boolean {
  return state === "provisioning" || state === "attaching" || state === "starting";
}
