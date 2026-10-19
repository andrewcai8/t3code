import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { routeSelection } from "./accountRouting.ts";

const projectId = ProjectId.make("project-1");
const now = Date.parse("2026-09-03T12:00:00.000Z");
const decodeSettings = Schema.decodeSync(ServerSettings);
const settings = (input: Record<string, unknown> = {}) =>
  decodeSettings({
    providerInstances: {
      claudeAgent: { driver: "claudeAgent" },
      claude_work: { driver: "claudeAgent" },
      claude_home: { driver: "claudeAgent" },
      codex: { driver: "codex" },
    },
    ...input,
  });

const provider = (
  instanceId: string,
  usedPercent: number | null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId === "codex" ? "codex" : "claudeAgent"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-03T11:55:00.000Z",
  models: [{ slug: "claude-opus", name: "Opus", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...(usedPercent === null
    ? {}
    : {
        usageLimits: {
          checkedAt: "2026-09-03T11:55:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent,
              resetsAt: "2026-09-03T14:00:00.000Z",
            },
          ],
        },
      }),
  ...overrides,
});

const selection = (instanceId: string) => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model: "claude-opus",
});

const route = (
  selected: string,
  providers: ReadonlyArray<ServerProvider>,
  extra: { current?: string; settings?: ServerSettings; load?: Record<string, number> } = {},
) =>
  routeSelection({
    projectId,
    selection: selection(selected),
    ...(extra.current === undefined ? {} : { current: ProviderInstanceId.make(extra.current) }),
    settings: extra.settings ?? settings(),
    providers,
    now,
    ...(extra.load === undefined
      ? {}
      : {
          load: new Map(
            Object.entries(extra.load).map(([id, count]) => [ProviderInstanceId.make(id), count]),
          ),
        }),
  }).instanceId;

describe("routeSelection", () => {
  it("starts a new chat on the account of the driver with the most usage left", () => {
    expect(
      route("claudeAgent", [
        provider("claudeAgent", 90),
        provider("claude_work", 10),
        provider("claude_home", 50),
      ]),
    ).toBe("claude_work");
  });

  it("spreads chats across accounts it has no readings for", () => {
    expect(
      route(
        "claudeAgent",
        [
          provider("claudeAgent", null),
          provider("claude_work", null),
          provider("claude_home", null),
        ],
        { load: { claudeAgent: 2, claude_work: 1 } },
      ),
    ).toBe("claude_home");
  });

  it("skips accounts that are signed out, disabled for the project, or lack the model", () => {
    expect(
      route(
        "claudeAgent",
        [
          provider("claudeAgent", 90),
          provider("claude_work", 0, { auth: { status: "unauthenticated" } }),
          provider("claude_home", 0, { models: [] }),
        ],
        {
          settings: settings({
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { claude_home: { enabled: false } } },
            },
          }),
        },
      ),
    ).toBe("claudeAgent");
  });

  it("keeps a thread on its account when a follow-up names another account of the driver", () => {
    expect(
      route("claudeAgent", [provider("claudeAgent", 0), provider("claude_work", 95)], {
        current: "claude_work",
      }),
    ).toBe("claude_work");
  });

  it("routes a thread moving to another driver among that driver's accounts", () => {
    expect(
      route("claude_home", [provider("claude_home", 90), provider("claude_work", 10)], {
        current: "codex",
      }),
    ).toBe("claude_work");
  });

  it("leaves the selection alone when the setting is off", () => {
    expect(
      route("claudeAgent", [provider("claudeAgent", 90), provider("claude_work", 10)], {
        settings: settings({ autoPickProviderAccounts: false }),
      }),
    ).toBe("claudeAgent");
  });
});
