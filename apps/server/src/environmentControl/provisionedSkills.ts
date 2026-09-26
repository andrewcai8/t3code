import type { ServerProvider, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readSkillDirectory } from "../provider/Drivers/ClaudeSkills.ts";
import type { Provisioning } from "./config.ts";

type SkillBundle = NonNullable<Provisioning["skills"]>[number];
type ProvisionedDriver = NonNullable<SkillBundle["agents"]>[number];

const ALL_DRIVERS: ReadonlyArray<ProvisionedDriver> = ["codex", "cursor", "claudeAgent"];

/** Skills a provisioned environment receives, by the driver whose root they land in. */
type ProvisionedSkills = ReadonlyMap<string, ReadonlyArray<ServerProviderSkill>>;

const readProvisionedSkills = Effect.fn("readProvisionedSkills")(function* (
  bundles: ReadonlyArray<SkillBundle>,
): Effect.fn.Return<ProvisionedSkills, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const byDriver = new Map<string, Map<string, ServerProviderSkill>>();
  for (const bundle of bundles) {
    // Mirrors provisioning's layout: a named bundle is one skill directory,
    // otherwise each child of the source lands in the skill root.
    const directories = bundle.name
      ? [{ directory: bundle.source, name: bundle.name }]
      : (yield* fileSystem
          .readDirectory(bundle.source)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
          .toSorted()
          .map((entry) => ({ directory: path.join(bundle.source, entry), name: entry }));
    for (const { directory, name } of directories) {
      const skill = yield* readSkillDirectory(directory, name, "user");
      if (!skill) continue;
      for (const driver of bundle.agents ?? ALL_DRIVERS) {
        const skills = byDriver.get(driver) ?? new Map<string, ServerProviderSkill>();
        skills.set(skill.name, skill);
        byDriver.set(driver, skills);
      }
    }
  }
  return new Map([...byDriver].map(([driver, skills]) => [driver, [...skills.values()]]));
});

/**
 * Describe what a provisioned environment's agents can run, for a host that
 * runs every chat in one. The host's own probe cannot see these skills: they
 * exist on it only as copy sources. A provisioned skill replaces a probed one
 * of the same name, since the environment's copy is the one that runs.
 */
export const withProvisionedSkills = Effect.fn("withProvisionedSkills")(function* (
  providers: ReadonlyArray<ServerProvider>,
  bundles: ReadonlyArray<SkillBundle>,
): Effect.fn.Return<ReadonlyArray<ServerProvider>, never, FileSystem.FileSystem | Path.Path> {
  if (bundles.length === 0) return providers;
  const provisioned = yield* readProvisionedSkills(bundles);
  return providers.map((provider) => {
    const skills = provisioned.get(provider.driver);
    if (!skills) return provider;
    const names = new Set(skills.map((skill) => skill.name));
    return {
      ...provider,
      skills: [...provider.skills.filter((skill) => !names.has(skill.name)), ...skills].toSorted(
        (left, right) => left.name.localeCompare(right.name),
      ),
    };
  });
});
