// @effect-diagnostics nodeBuiltinImport:off - this test writes a private control config and skill bundles.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { EnvironmentControl, layer } from "./EnvironmentControl.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const writeSkill = async (root: string, directory: string, frontmatter: ReadonlyArray<string>) => {
  await NodeFSP.mkdir(NodePath.join(root, directory), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, directory, "SKILL.md"),
    ["---", ...frontmatter, "---", "", `# ${directory}`, ""].join("\n"),
  );
};

const onHost = (localAgentRuns: boolean) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provisioned-skills-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const claudeBundle = NodePath.join(directory, "claude-skills");
    const codexCursorBundle = NodePath.join(directory, "codex-cursor-skills");
    yield* Effect.promise(async () => {
      await writeSkill(claudeBundle, "poteto-mode", ["name: poteto-mode", "description: Claude."]);
      await writeSkill(claudeBundle, "why", ["name: why", "description: Explain history."]);
      await writeSkill(codexCursorBundle, "poteto-mode", ["name: poteto-mode"]);
      // Codex matches the frontmatter name; Claude and Cursor match the folder.
      await writeSkill(codexCursorBundle, "how-folder", ["name: how", "description: Explain."]);
      await writeSkill(codexCursorBundle, "desktop-only", [
        "name: desktop-only",
        "metadata:",
        "  surfaces: [desktop]",
      ]);
      // Provisioning copies no linked folder, so none is listed.
      await NodeFSP.symlink(
        NodePath.join(claudeBundle, "why"),
        NodePath.join(codexCursorBundle, "linked"),
      );
      await writeSkill(directory, "deploy-skill", ["name: deploy-skill", "description: Ship."]);
      await NodeFSP.writeFile(
        NodePath.join(directory, "environment-control.json"),
        encodeJson({
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
              { source: NodePath.join(directory, "deploy-skill"), name: "deploy" },
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
    const services = yield* Layer.build(
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
    );
    return {
      control: Context.get(services, EnvironmentControl),
      codexCursorBundle,
      configPath: NodePath.join(directory, "environment-control.json"),
    };
  });

const namesByDriver = (
  skills: Record<string, ReadonlyArray<{ readonly name: string }> | undefined> | undefined,
) =>
  skills &&
  Object.fromEntries(
    Object.entries(skills).map(([driver, list]) => [driver, list?.map((skill) => skill.name)]),
  );

it.effect("lists each driver's provisioned skills on a host that runs no agents", () =>
  Effect.gen(function* () {
    const { control, codexCursorBundle } = yield* onHost(false);
    const skills = yield* control.provisionedSkills;

    assert.deepEqual(namesByDriver(skills), {
      codex: ["deploy-skill", "desktop-only", "how", "poteto-mode"],
      claudeAgent: ["deploy", "poteto-mode", "why"],
      cursor: ["deploy", "how-folder", "poteto-mode"],
    });
    assert.deepEqual(skills?.claudeAgent?.[2], {
      name: "why",
      enabled: true,
      scope: "user",
      description: "Explain history.",
    });

    assert.strictEqual(yield* control.provisionedSkills, skills, "unchanged bundles are cached");
    yield* Effect.promise(() =>
      writeSkill(codexCursorBundle, "added", ["name: added", "description: New."]),
    );
    assert.deepEqual(namesByDriver(yield* control.provisionedSkills)?.cursor, [
      "added",
      "deploy",
      "how-folder",
      "poteto-mode",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("reports no provisioned skills on a host that runs agents itself", () =>
  Effect.gen(function* () {
    const { control } = yield* onHost(true);
    assert.strictEqual(yield* control.provisionedSkills, undefined);
  }).pipe(Effect.scoped),
);

it.effect("keeps a config that failed to load failed until the file changes", () =>
  Effect.gen(function* () {
    const { control, configPath } = yield* onHost(false);
    const valid = yield* Effect.promise(() => NodeFSP.readFile(configPath, "utf8"));
    const rewrite = (contents: string, mtime: Date) =>
      Effect.promise(async () => {
        await NodeFSP.writeFile(configPath, contents);
        await NodeFSP.utimes(configPath, mtime, mtime);
      });
    const broken = new Date("2026-01-01T00:00:00.000Z");

    yield* rewrite("{", broken);
    assert.strictEqual(yield* control.provisionedSkills, undefined);
    yield* rewrite(valid, broken);
    assert.strictEqual(yield* control.provisionedSkills, undefined, "same mtime, cached failure");
    yield* rewrite(valid, new Date("2026-01-02T00:00:00.000Z"));
    assert.deepEqual(namesByDriver(yield* control.provisionedSkills)?.claudeAgent, [
      "deploy",
      "poteto-mode",
      "why",
    ]);
  }).pipe(Effect.scoped),
);
