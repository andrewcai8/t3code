// @effect-diagnostics nodeBuiltinImport:off - this test writes a private control config and skill bundles.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { EnvironmentControl, layer } from "./EnvironmentControl.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";

const provider = (driver: string, skills: ReadonlyArray<ServerProviderSkill> = []) =>
  ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-26T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills,
  }) satisfies ServerProvider;

const writeSkill = (root: string, name: string, description: string) =>
  NodeFSP.mkdir(NodePath.join(root, name), { recursive: true }).then(() =>
    NodeFSP.writeFile(
      NodePath.join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    ),
  );

const withProvisionedSkillsOnHost = (
  localAgentRuns: boolean,
  providers: ReadonlyArray<ServerProvider>,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provisioned-skills-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const claudeBundle = NodePath.join(directory, "claude-skills");
    const codexCursorBundle = NodePath.join(directory, "codex-cursor-skills");
    const deploySkill = NodePath.join(directory, "deploy-skill");
    yield* Effect.promise(async () => {
      await writeSkill(claudeBundle, "poteto-mode", "Claude port.");
      await writeSkill(claudeBundle, "why", "Explain history.");
      await writeSkill(codexCursorBundle, "poteto-mode", "Codex and Cursor port.");
      await writeSkill(codexCursorBundle, "how", "Explain a subsystem.");
      await writeSkill(directory, "deploy-skill", "Deploy the app.");
      await NodeFSP.writeFile(
        NodePath.join(directory, "environment-control.json"),
        JSON.stringify({
          e2bApiKey: "unused-test-key",
          broker: {
            sandboxId: "unused",
            metadata: { owner: "fixture" },
            url: "https://unused.invalid",
            ingressKey: "unused",
          },
          targets: [],
          provisioning: {
            skills: [
              { source: claudeBundle, agents: ["claudeAgent"] },
              { source: codexCursorBundle, agents: ["codex", "cursor"] },
              { source: deploySkill, name: "deploy" },
            ],
          },
        }),
      );
    });
    vi.stubEnv(
      "T3CODE_ENVIRONMENT_CONTROL_CONFIG",
      NodePath.join(directory, "environment-control.json"),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const result = yield* Effect.gen(function* () {
      const control = yield* EnvironmentControl;
      return yield* control.withProvisionedSkills(providers);
    }).pipe(
      Effect.provide(
        Layer.merge(layer, ProvisionOperationStore.layer).pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(makeProviderRegistryLayer()),
          Layer.provideMerge(
            Layer.effect(
              ServerConfig.ServerConfig,
              Effect.gen(function* () {
                return { ...(yield* ServerConfig.ServerConfig), localAgentRuns };
              }),
            ).pipe(Layer.provide(ServerConfig.layerTest(directory, directory))),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    return { result, directory };
  });

const skillNamesByDriver = (providers: ReadonlyArray<ServerProvider>) =>
  Object.fromEntries(
    providers.map((entry) => [entry.driver, entry.skills.map((skill) => skill.name)]),
  );

it.effect("lists each driver's provisioned skills on a host that runs no agents", () =>
  Effect.gen(function* () {
    const { result, directory } = yield* withProvisionedSkillsOnHost(false, [
      provider("codex", [
        { name: "how", path: "/host/.codex/skills/how/SKILL.md", enabled: true },
        { name: "skill-creator", path: "/codex/system/skill-creator/SKILL.md", enabled: true },
      ]),
      provider("claudeAgent"),
      provider("cursor"),
      provider("opencode"),
    ]);

    assert.deepEqual(skillNamesByDriver(result), {
      codex: ["deploy", "how", "poteto-mode", "skill-creator"],
      claudeAgent: ["deploy", "poteto-mode", "why"],
      cursor: ["deploy", "how", "poteto-mode"],
      opencode: [],
    });
    assert.deepEqual(
      result
        .find((entry) => entry.driver === "codex")
        ?.skills.find((skill) => skill.name === "how"),
      {
        name: "how",
        path: NodePath.join(directory, "codex-cursor-skills", "how", "SKILL.md"),
        enabled: true,
        scope: "user",
        description: "Explain a subsystem.",
      },
    );
  }).pipe(Effect.scoped),
);

it.effect("leaves snapshots alone on a host that runs agents itself", () =>
  Effect.gen(function* () {
    const { result } = yield* withProvisionedSkillsOnHost(true, [
      provider("codex"),
      provider("claudeAgent"),
      provider("cursor"),
    ]);

    assert.deepEqual(skillNamesByDriver(result), { codex: [], claudeAgent: [], cursor: [] });
  }).pipe(Effect.scoped),
);
