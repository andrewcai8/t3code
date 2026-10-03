import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderSkillsForCwd } from "./providerSkills.ts";

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
