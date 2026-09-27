import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationInputFromDraft,
  automationRepositoryOptions,
  automationTriggerSummary,
  automationWebhookUrl,
  describeSchedule,
  newAutomationDraft,
  nextRuns,
  presetCron,
  presetFromCron,
  withPresetKind,
  type AutomationDraft,
} from "./automations.logic";

const draft = (patch: Partial<AutomationDraft>): AutomationDraft => ({
  ...newAutomationDraft({ agentDriver: "codex", provider: "e2b", timeZone: "America/New_York" }),
  name: " Nightly triage ",
  repository: "acme/app",
  prompt: "Triage new issues.",
  ...patch,
});

const iso = (dates: ReadonlyArray<Date>) => dates.map((date) => date.toISOString());
// Some ICU builds put a narrow no-break space before the day period.
const plain = (text: string) => text.replace(/\u202f/g, " ");

describe("schedule presets", () => {
  it("writes each preset as cron", () => {
    expect([
      presetCron({ kind: "hourly", minute: 15 }),
      presetCron({ kind: "daily", hour: 9, minute: 0 }),
      presetCron({ kind: "weekdays", hour: 9, minute: 0 }),
      presetCron({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }),
      presetCron({ kind: "custom", cron: " 0 9 1 * * " }),
    ]).toEqual(["15 * * * *", "0 9 * * *", "0 9 * * 1-5", "0 9 * * 1", "0 9 1 * *"]);
  });

  it("reads a preset-shaped cron back and leaves anything else custom", () => {
    expect(["15 * * * *", "30 18 * * *", "0 9 * * 1-5", "45 7 * * 0"].map(presetFromCron)).toEqual([
      { kind: "hourly", minute: 15 },
      { kind: "daily", hour: 18, minute: 30 },
      { kind: "weekdays", hour: 9, minute: 0 },
      { kind: "weekly", weekday: 0, hour: 7, minute: 45 },
    ]);
    expect(["0 9 1 * *", "*/15 * * * *", "09 9 * * *", "0 9 * * 7"].map(presetFromCron)).toEqual([
      { kind: "custom", cron: "0 9 1 * *" },
      { kind: "custom", cron: "*/15 * * * *" },
      { kind: "custom", cron: "09 9 * * *" },
      { kind: "custom", cron: "0 9 * * 7" },
    ]);
  });

  it("keeps the time of day when switching kinds and writes custom out as cron", () => {
    const daily = { kind: "daily", hour: 18, minute: 30 } as const;
    expect(withPresetKind(daily, "weekly")).toEqual({
      kind: "weekly",
      weekday: 1,
      hour: 18,
      minute: 30,
    });
    expect(withPresetKind(daily, "custom")).toEqual({ kind: "custom", cron: "30 18 * * *" });
  });
});

describe("nextRuns", () => {
  it("lists weekday mornings in New York across the November clock change", () => {
    const schedule = { cron: "0 9 * * 1-5", timeZone: "America/New_York" };
    expect(iso(nextRuns(schedule, Date.parse("2026-10-29T14:00:00.000Z"), 3))).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
      "2026-11-03T14:00:00.000Z",
    ]);
  });

  it("returns nothing for a cron it cannot read", () => {
    expect(nextRuns({ cron: "0 9 * *", timeZone: "UTC" }, 0, 3)).toEqual([]);
  });
});

describe("describeSchedule", () => {
  const viewer = { locale: "en-US", timeZone: "America/New_York" };
  it("reads naturally and names the zone only when it is not the viewer's", () => {
    expect(
      [
        { cron: "15 * * * *", timeZone: "America/New_York" },
        { cron: "0 9 * * 1-5", timeZone: "America/New_York" },
        { cron: "30 18 * * *", timeZone: "America/New_York" },
        { cron: "0 9 * * 1", timeZone: "Europe/London" },
        { cron: "0 9 1 * *", timeZone: "America/New_York" },
      ].map((schedule) => plain(describeSchedule(schedule, viewer))),
    ).toEqual([
      "Every hour at :15",
      "Weekdays at 9:00 AM",
      "Every day at 6:30 PM",
      "Every Monday at 9:00 AM (Europe/London)",
      "0 9 1 * *",
    ]);
  });

  it("summarises the triggers an automation has", () => {
    const schedule = { cron: "0 9 * * 1-5", timeZone: "America/New_York" };
    expect(
      [
        { schedule, webhook: true },
        { schedule: null, webhook: true },
        { schedule: null, webhook: false },
      ].map((automation) => plain(automationTriggerSummary(automation, viewer))),
    ).toEqual(["Weekdays at 9:00 AM · Webhook", "Webhook", "Run now only"]);
  });
});

describe("automationRepositoryOptions", () => {
  it("offers each clonable repository once, from the first checkout that has it", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const identity = (owner: string, name: string) => ({
      canonicalKey: `github.com/${owner}/${name}`,
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `git@github.com:${owner}/${name}.git`,
      },
      owner,
      name,
    });
    expect(
      automationRepositoryOptions([
        {
          environmentId: local,
          title: "t3code",
          workspaceRoot: "/Users/andrew/t3code",
          repositoryIdentity: {
            ...identity("pingdotgg", "t3code"),
            origin: {
              owner: "andrewcai8",
              name: "t3code",
              remoteUrl: "git@github.com:andrewcai8/t3code.git",
            },
          },
        },
        {
          environmentId: remote,
          title: "t3code on the mini",
          workspaceRoot: "/home/andrew/t3code",
          repositoryIdentity: identity("andrewcai8", "t3code"),
        },
        {
          environmentId: local,
          title: "scratch",
          workspaceRoot: "/Users/andrew/scratch",
          repositoryIdentity: null,
        },
        {
          environmentId: remote,
          title: "Docs",
          workspaceRoot: "/home/andrew/docs",
          repositoryIdentity: identity("acme", "docs"),
        },
      ]),
    ).toEqual([
      {
        repository: "acme/docs",
        label: "Docs",
        source: { environmentId: "remote", cwd: "/home/andrew/docs" },
      },
      {
        repository: "andrewcai8/t3code",
        label: "t3code",
        source: { environmentId: "local", cwd: "/Users/andrew/t3code" },
      },
    ]);
  });
});

describe("automationInputFromDraft", () => {
  it("trims fields and turns empty choices into nulls", () => {
    expect(automationInputFromDraft(draft({ branch: "  " }))).toEqual({
      kind: "valid",
      input: {
        name: "Nightly triage",
        repository: "acme/app",
        branch: null,
        prompt: "Triage new issues.",
        agentDriver: "codex",
        account: null,
        model: null,
        provider: "e2b",
        schedule: null,
        webhook: false,
        enabled: true,
      },
    });
  });

  it("carries a schedule, a webhook, a branch, a pinned account, and a model", () => {
    expect(
      automationInputFromDraft(
        draft({
          scheduled: true,
          schedule: { kind: "daily", hour: 6, minute: 30 },
          webhook: true,
          branch: "main",
          account: "codex_work",
          model: "gpt-6-mini",
        }),
      ),
    ).toEqual({
      kind: "valid",
      input: {
        name: "Nightly triage",
        repository: "acme/app",
        branch: "main",
        prompt: "Triage new issues.",
        agentDriver: "codex",
        account: "codex_work",
        model: "gpt-6-mini",
        provider: "e2b",
        schedule: { cron: "30 6 * * *", timeZone: "America/New_York" },
        webhook: true,
        enabled: true,
      },
    });
  });

  it("accepts a webhook-only automation", () => {
    const result = automationInputFromDraft(draft({ scheduled: false, webhook: true }));
    expect(result.kind === "valid" && [result.input.schedule, result.input.webhook]).toEqual([
      null,
      true,
    ]);
  });

  it("names each required pick that is missing", () => {
    expect(
      automationInputFromDraft(
        draft({ name: " ", repository: "", prompt: "", agentDriver: "", provider: "" }),
      ),
    ).toEqual({
      kind: "invalid",
      errors: {
        name: "Name the automation.",
        repository: "Choose a repository.",
        prompt: "Write what the agent should do.",
        agentDriver: "Choose an agent.",
        provider: "Choose where it runs.",
      },
    });
  });

  it("holds a custom cron to the 15-minute minimum and ignores it while the schedule is off", () => {
    const custom = (cron: string, scheduled = true) =>
      automationInputFromDraft(draft({ scheduled, schedule: { kind: "custom", cron } }));
    expect(custom("*/5 * * * *")).toEqual({
      kind: "invalid",
      errors: { schedule: "Runs must be at least 15 minutes apart." },
    });
    expect(custom("*/15 * * * *").kind).toBe("valid");
    expect(custom("0 9 * *")).toEqual({
      kind: "invalid",
      errors: { schedule: "Use five cron fields, such as 0 9 * * 1-5, and an IANA time zone." },
    });
    expect(custom("nope", false).kind).toBe("valid");
  });

  it("puts a wire-schema failure under the field that failed", () => {
    expect(automationInputFromDraft(draft({ account: "work account" }))).toEqual({
      kind: "invalid",
      errors: { account: "Expected a string matching the RegExp ^[a-zA-Z][a-zA-Z0-9_-]*$" },
    });
  });
});

describe("automationWebhookUrl", () => {
  it("appends the hook path under the manager's base path", () => {
    expect(automationWebhookUrl("https://host.example/base/", "tok_123")).toBe(
      "https://host.example/base/api/automations/hooks/tok_123",
    );
    expect(automationWebhookUrl("http://127.0.0.1:3774", "a/b")).toBe(
      "http://127.0.0.1:3774/api/automations/hooks/a%2Fb",
    );
  });
});
