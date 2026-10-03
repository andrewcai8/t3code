import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getProviderSlashCommandsForSlashMenu,
  resolveProviderSkillsForCwd,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("getProviderSlashCommandsForSlashMenu", () => {
  it("drops the command Claude Code publishes under a skill's frontmatter name", () => {
    const potetoMode = {
      name: "poteto-mode",
      displayName: "Poteto Mode",
      path: "/Users/matt/.claude/skills/poteto-mode/SKILL.md",
      enabled: true,
    };

    expect(
      getProviderSlashCommandsForSlashMenu(
        [
          { name: "Poteto Mode", description: "poteto's agent style." },
          { name: "compact", description: "Compact the conversation." },
        ],
        [potetoMode],
      ).map((command) => command.name),
    ).toEqual(["compact"]);
  });
});

describe("provisioned skills", () => {
  it("lists the provider driver's provisioned skills first, winning a name clash", () => {
    expect(
      resolveProviderSkillsForCwd(provider, "/workspace/project-a", {
        codex: [
          { name: "project", description: "Provisioned copy.", enabled: true, scope: "user" },
          { name: "how", enabled: true, scope: "user" },
        ],
        claudeAgent: [{ name: "claude-only", enabled: true, scope: "user" }],
      }),
    ).toEqual([
      { name: "project", description: "Provisioned copy.", enabled: true, scope: "user" },
      { name: "how", enabled: true, scope: "user" },
      { name: "global", path: "/global/SKILL.md", enabled: true },
    ]);
  });

  it("keeps the provider's own skills when its driver has none provisioned", () => {
    expect(
      resolveProviderSkillsForCwd(provider, null, {
        claudeAgent: [{ name: "claude-only", enabled: true, scope: "user" }],
      }),
    ).toEqual([{ name: "global", path: "/global/SKILL.md", enabled: true }]);
  });
});
