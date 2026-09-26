// @effect-diagnostics nodeBuiltinImport:off - bundles are read at the same Promise-based boundary provisioning copies them from.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ServerProvisionedSkill, ServerProvisionedSkills } from "@t3tools/contracts";

import {
  parseSkillFrontmatter,
  type CursorSkillFrontmatter,
} from "../provider/Drivers/CursorSkills.ts";
import type { Provisioning } from "./config.ts";

type SkillBundle = NonNullable<Provisioning["skills"]>[number];
type ProvisionedDriver = keyof ServerProvisionedSkills;

const ALL_DRIVERS: ReadonlyArray<ProvisionedDriver> = ["codex", "claudeAgent", "cursor"];

const invocation = (frontmatter: CursorSkillFrontmatter) => ({
  ...(frontmatter.description ? { description: frontmatter.description } : {}),
  ...(frontmatter.userInvocationOnly ? { userInvocationOnly: true } : {}),
  ...(frontmatter.userInvocable === false ? { userInvocable: false } : {}),
});

/**
 * The entry each driver's adapter in the environment would report for one
 * skill directory, or `undefined` when that adapter would not offer it.
 * Claude and Cursor key a skill by its directory, Codex by its frontmatter
 * `name`. Cursor hides a skill whose `metadata.surfaces` leaves out the CLI.
 */
const entryFor: Record<
  ProvisionedDriver,
  (directory: string, frontmatter: CursorSkillFrontmatter) => ServerProvisionedSkill | undefined
> = {
  claudeAgent: (directory, frontmatter) => ({
    name: directory,
    enabled: true,
    scope: "user",
    ...invocation(frontmatter),
  }),
  codex: (_directory, frontmatter) =>
    frontmatter.displayName
      ? {
          name: frontmatter.displayName,
          enabled: true,
          scope: "user",
          ...(frontmatter.description ? { description: frontmatter.description } : {}),
        }
      : undefined,
  cursor: (directory, frontmatter) =>
    frontmatter.cliVisible
      ? {
          name: directory,
          enabled: true,
          scope: "user",
          ...(frontmatter.displayName && frontmatter.displayName !== directory
            ? { displayName: frontmatter.displayName }
            : {}),
          ...invocation(frontmatter),
        }
      : undefined,
};

/**
 * Mirrors provisioning's layout: a named bundle is one skill, otherwise each
 * child directory of the source is one. Provisioning copies no linked
 * directory, so a linked child never reaches an environment.
 */
async function skillDirectories(bundle: SkillBundle) {
  if (bundle.name) return [{ path: bundle.source, name: bundle.name }];
  const entries = await NodeFSP.readdir(bundle.source, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ path: NodePath.join(bundle.source, entry.name), name: entry.name }));
}

export async function readProvisionedSkills(
  bundles: ReadonlyArray<SkillBundle>,
): Promise<ServerProvisionedSkills> {
  const byDriver = new Map<ProvisionedDriver, Map<string, ServerProvisionedSkill>>();
  for (const bundle of bundles) {
    for (const directory of await skillDirectories(bundle)) {
      const contents = await NodeFSP.readFile(
        NodePath.join(directory.path, "SKILL.md"),
        "utf8",
      ).catch(() => undefined);
      const frontmatter = contents === undefined ? undefined : parseSkillFrontmatter(contents);
      if (!frontmatter) continue;
      for (const driver of bundle.agents ?? ALL_DRIVERS) {
        const skill = entryFor[driver](directory.name, frontmatter);
        if (!skill) continue;
        const skills = byDriver.get(driver) ?? new Map<string, ServerProvisionedSkill>();
        skills.set(skill.name, skill);
        byDriver.set(driver, skills);
      }
    }
  }
  const sorted = (driver: ProvisionedDriver) =>
    [...(byDriver.get(driver)?.values() ?? [])].toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
  return {
    ...(byDriver.has("codex") ? { codex: sorted("codex") } : {}),
    ...(byDriver.has("claudeAgent") ? { claudeAgent: sorted("claudeAgent") } : {}),
    ...(byDriver.has("cursor") ? { cursor: sorted("cursor") } : {}),
  };
}
