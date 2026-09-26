import {
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  AutomationInput,
  parseAutomationCron,
  type Automation,
  type AutomationRunState,
  type ProvisionProvider,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The editable form of an automation. Empty strings mean "not chosen yet". */
export interface AutomationDraft {
  readonly name: string;
  readonly repository: string;
  readonly branch: string;
  readonly prompt: string;
  readonly agentDriver: string;
  /** Empty runs each time on the account with the most usage left. */
  readonly account: string;
  readonly provider: ProvisionProvider | "";
  readonly scheduled: boolean;
  readonly cron: string;
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

const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const decodeAutomationInput = Schema.decodeUnknownSync(AutomationInput);
const DRAFT_FIELDS: ReadonlyArray<AutomationDraftField> = [
  "name",
  "repository",
  "branch",
  "prompt",
  "agentDriver",
  "account",
  "provider",
  "schedule",
];

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
    provider: defaults.provider,
    scheduled: false,
    cron: "0 9 * * 1-5",
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
    provider: automation.provider,
    scheduled: automation.schedule !== null,
    cron: automation.schedule?.cron ?? "0 9 * * 1-5",
    timeZone: automation.schedule?.timeZone ?? timeZone,
    webhook: automation.webhook,
    enabled: automation.enabled,
  };
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
  const cron = draft.cron.trim();
  const timeZone = draft.timeZone.trim();
  if (name.length === 0) errors.name = "Name the automation.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";
  if (!REPOSITORY_PATTERN.test(repository)) errors.repository = "Use owner/name.";
  if (draft.prompt.trim().length === 0) errors.prompt = "Write what the agent should do.";
  else if (draft.prompt.trim().length > 20_000)
    errors.prompt = "Keep the prompt under 20,000 characters.";
  if (draft.agentDriver === "") errors.agentDriver = "Choose an agent.";
  if (draft.provider === "") errors.provider = "Choose where it runs.";
  if (draft.scheduled && parseAutomationCron(cron, timeZone) === null)
    errors.schedule = "Use five cron fields, such as 0 9 * * 1-5, and an IANA time zone.";
  const candidate = {
    name,
    repository,
    branch: draft.branch.trim() || null,
    prompt: draft.prompt,
    agentDriver: draft.agentDriver,
    account: draft.account || null,
    provider: draft.provider,
    schedule: draft.scheduled ? { cron, timeZone } : null,
    webhook: draft.webhook,
    enabled: draft.enabled,
  };
  for (const field of DRAFT_FIELDS) {
    if (errors[field] !== undefined) continue;
    const decoded = Schema.decodeUnknownResult(AutomationInput.fields[field])(candidate[field]);
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

export function automationTriggerLabel(automation: Automation): string {
  if (automation.schedule !== null)
    return `${automation.schedule.cron} (${automation.schedule.timeZone})${automation.webhook ? " · Webhook" : ""}`;
  return automation.webhook ? "Webhook" : "Manual";
}
