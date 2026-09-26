import { describe, expect, it } from "vite-plus/test";

import {
  automationInputFromDraft,
  automationWebhookUrl,
  newAutomationDraft,
  type AutomationDraft,
} from "./AutomationsSettings.logic";

const draft = (patch: Partial<AutomationDraft>): AutomationDraft => ({
  ...newAutomationDraft({ agentDriver: "codex", provider: "e2b", timeZone: "America/New_York" }),
  name: " Nightly triage ",
  repository: " acme/app ",
  prompt: "Triage new issues.",
  ...patch,
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
        provider: "e2b",
        schedule: null,
        webhook: false,
        enabled: true,
      },
    });
  });

  it("keeps a schedule, a branch, and a pinned account", () => {
    const result = automationInputFromDraft(
      draft({ scheduled: true, cron: " 30 6 * * * ", branch: "main", account: "codex_work" }),
    );
    expect(result.kind === "valid" && result.input).toMatchObject({
      branch: "main",
      account: "codex_work",
      schedule: { cron: "30 6 * * *", timeZone: "America/New_York" },
    });
  });

  it("names each field that needs fixing", () => {
    expect(
      automationInputFromDraft(
        draft({
          name: " ",
          repository: "app",
          prompt: "",
          agentDriver: "",
          provider: "",
          scheduled: true,
          cron: "0 9 * *",
        }),
      ),
    ).toEqual({
      kind: "invalid",
      errors: {
        name: "Name the automation.",
        repository: "Use owner/name.",
        prompt: "Write what the agent should do.",
        agentDriver: "Choose an agent.",
        provider: "Choose where it runs.",
        schedule: "Use five cron fields, such as 0 9 * * 1-5, and an IANA time zone.",
      },
    });
  });

  it("rejects an unknown time zone and ignores a bad cron while the schedule is off", () => {
    expect(automationInputFromDraft(draft({ scheduled: true, timeZone: "Mars/Olympus" }))).toEqual({
      kind: "invalid",
      errors: { schedule: "Use five cron fields, such as 0 9 * * 1-5, and an IANA time zone." },
    });
    expect(automationInputFromDraft(draft({ scheduled: false, cron: "nope" })).kind).toBe("valid");
  });

  it("shows the minimum interval under the schedule, even before other fields are filled", () => {
    expect(
      automationInputFromDraft(draft({ name: "", scheduled: true, cron: "*/10 * * * *" })),
    ).toEqual({
      kind: "invalid",
      errors: { name: "Name the automation.", schedule: "Runs must be at least 15 minutes apart." },
    });
    expect(
      automationInputFromDraft(draft({ scheduled: true, cron: "0,15,30,45 * * * *" })).kind,
    ).toBe("valid");
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
