// @effect-diagnostics nodeBuiltinImport:off - tests exercise private immutable filesystem inputs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  EnvironmentProvisionInput,
  ProviderInstanceId,
  ProvisionRequestConflict,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ServerSettings } from "@t3tools/contracts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { makeProvisionPreparationStore, provisionDigest } from "./ProvisionPreparation.ts";
import type { EnvironmentControlConfig } from "./config.ts";
import type { ProvisioningProviderProfile } from "./ProvisioningProviderProfile.ts";
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const evidence = {
  destination: ".repair/evidence.txt",
  sha256: provisionDigest("evidence"),
  contentsBase64: Buffer.from("evidence").toString("base64"),
};
const input = Schema.decodeUnknownSync(EnvironmentProvisionInput)({
  requestId: "05d43b4e-0b92-477b-9503-31a377147fb0",
  provider: "e2b",
  providerInstanceId: "codex",
  repository: "example/repo",
  workspaceFiles: [evidence],
  retentionDeadline: "2099-01-01T00:00:00.000Z",
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "provision-preparation-"));
  await NodeFSP.mkdir(NodePath.join(root, ".codex"));
  await NodeFSP.writeFile(NodePath.join(root, ".codex/auth.json"), "private-fixture-credential");
  await NodeFSP.writeFile(NodePath.join(root, "runtime.tar"), "artifact");
  const config: EnvironmentControlConfig = {
    targets: [],
    e2bApiKey: "fixture",
    broker: {
      sandboxId: "broker",
      metadata: {},
      url: "https://fixture.invalid",
      ingressKey: "fixture",
    },
    provisioning: {
      templateId: "mutable-alias",
      runtimeArtifacts: {
        linux: {
          path: NodePath.join(root, "runtime.tar"),
          sha256: provisionDigest("artifact"),
          revision: "c".repeat(40),
          entrypoint: "dist/bin.mjs",
          runtimeExecutable: "node",
        },
        macos: {
          path: NodePath.join(root, "runtime.tar"),
          sha256: provisionDigest("artifact"),
          revision: "c".repeat(40),
          entrypoint: "dist/bin.mjs",
          runtimeExecutable: "node",
        },
      },
    },
  };
  const profile: ProvisioningProviderProfile = {
    kind: "codex",
    instanceId: ProviderInstanceId.make("codex"),
    environment: [],
    credential: {
      kind: "file",
      source: NodePath.join(root, ".codex/auth.json"),
      destination: ".codex/auth.json",
    },
  };
  return {
    root,
    config,
    profile,
    store: makeProvisionPreparationStore(root),
    resolver: { template: async () => "canonical-template", revision: async () => "a".repeat(40) },
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}
it("freezes source, template, artifact and credentials across manager restart and rejects changed intent", async () => {
  const f = await fixture();
  try {
    const first = await f.store.freeze(input, f.config, f.resolver, f.profile);
    await NodeFSP.writeFile(NodePath.join(f.root, "runtime.tar"), "changed");
    await NodeFSP.writeFile(NodePath.join(f.root, ".codex/auth.json"), "changed");
    const again = await makeProvisionPreparationStore(f.root).freeze(
      input,
      { ...f.config, provisioning: undefined },
      {
        template: async () => {
          throw new Error("must not resolve");
        },
        revision: async () => {
          throw new Error("must not resolve");
        },
      },
      f.profile,
    );
    expect(again).toEqual(first);
    expect(first.request).toMatchObject({
      templateId: "canonical-template",
      retentionDeadline: input.retentionDeadline,
      sourceRevision: "a".repeat(40),
    });
    expect(
      first.preparation.files.find((file) => file.destination === ".codex/auth.json")
        ?.contentsBase64,
    ).toBe(Buffer.from("private-fixture-credential").toString("base64"));
    expect(await NodeFSP.readFile(first.localArtifact.path, "utf8")).toBe("artifact");
    expect((await NodeFSP.stat(NodePath.join(f.root, "provisioning"))).mode & 0o777).toBe(0o700);
    expect(
      (await NodeFSP.stat(NodePath.join(f.root, "provisioning", `${input.requestId}.json`))).mode &
        0o777,
    ).toBe(0o600);
    await expect(
      f.store.freeze({ ...input, branch: "other" }, f.config, f.resolver, f.profile),
    ).rejects.toBeInstanceOf(ProvisionRequestConflict);
    await expect(
      f.store.freeze(
        { ...input, retentionDeadline: "2099-01-02T00:00:00.000Z" },
        f.config,
        f.resolver,
        f.profile,
      ),
    ).rejects.toBeInstanceOf(ProvisionRequestConflict);
  } finally {
    await f.cleanup();
  }
});
it("concurrent manager instances adopt one complete manifest when resolution differs", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      ["a", "b", "c"].map((sha) =>
        makeProvisionPreparationStore(f.root).freeze(
          input,
          f.config,
          { ...f.resolver, revision: async () => sha.repeat(40) },
          f.profile,
        ),
      ),
    );
    expect(new Set(results.map((result) => result.request.preparationHash)).size).toBe(1);
    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect((await NodeFSP.readdir(NodePath.join(f.root, "provisioning"))).sort()).toEqual(
      [`${input.requestId}.json`, `${provisionDigest("artifact")}.tar`].sort(),
    );
  } finally {
    await f.cleanup();
  }
});
it("rejects corrupt files, escaping paths, duplicate destinations and unpinned legacy config", async () => {
  const f = await fixture();
  try {
    await expect(
      f.store.freeze(
        { ...input, workspaceFiles: [{ ...evidence, sha256: "0".repeat(64) }] },
        f.config,
        f.resolver,
        f.profile,
      ),
    ).rejects.toThrow("hash check");
    await expect(
      f.store.freeze(
        { ...input, workspaceFiles: [{ ...evidence, destination: "../secret" }] },
        f.config,
        f.resolver,
        f.profile,
      ),
    ).rejects.toThrow("relative path");
    await expect(
      f.store.freeze(
        { ...input, workspaceFiles: [evidence, evidence] },
        f.config,
        f.resolver,
        f.profile,
      ),
    ).rejects.toThrow("duplicate");
    await expect(
      f.store.freeze(
        input,
        { ...f.config, provisioning: { templateId: "old" } },
        f.resolver,
        f.profile,
      ),
    ).rejects.toThrow("pinned runtime artifact");
    const empty = await f.store.freeze(
      { ...input, repository: undefined },
      f.config,
      f.resolver,
      f.profile,
    );
    expect(empty.request.sourceRevision).toBeNull();
    expect(empty.preparation.repository).toBeNull();
  } finally {
    await f.cleanup();
  }
});

it("refuses a modified persisted preparation manifest", async () => {
  const f = await fixture();
  try {
    const first = await f.store.freeze(input, f.config, f.resolver, f.profile);
    const path = NodePath.join(f.root, "provisioning", `${input.requestId}.json`);
    await NodeFSP.writeFile(path, JSON.stringify({ ...first, egressAllow: ["changed.example"] }), {
      mode: 0o600,
    });
    await expect(f.store.freeze(input, f.config, f.resolver, f.profile)).rejects.toThrow(
      "Stored preparation manifest changed",
    );
  } finally {
    await f.cleanup();
  }
});

const decodeProvisionInput = Schema.decodeUnknownSync(EnvironmentProvisionInput);
/** The same request, aimed at a different agent CLI and account. */
const inputFor = (agentDriver: string, providerInstanceId: string) =>
  decodeProvisionInput({
    requestId: "05d43b4e-0b92-477b-9503-31a377147fb0",
    provider: "e2b",
    providerInstanceId,
    agentDriver,
    repository: "example/repo",
    workspaceFiles: [evidence],
    retentionDeadline: "2099-01-01T00:00:00.000Z",
  });

/** A skill bundle with nested content, as a real playbook directory has. */
async function skillBundle(root: string) {
  const source = NodePath.join(root, "bundles/pstack");
  await NodeFSP.mkdir(NodePath.join(source, "skills/why"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(source, "SKILL.md"), "---\nname: pstack\n---\n");
  await NodeFSP.writeFile(NodePath.join(source, "skills/why/SKILL.md"), "why\n");
  return source;
}
const homeFile = (
  manifest: Awaited<ReturnType<ReturnType<typeof makeProvisionPreparationStore>["freeze"]>>,
  destination: string,
) =>
  manifest.preparation.files.find(
    (item) => item.scope === "home" && item.destination === destination,
  );

it("leaves installed dependencies and Git history out of a skill bundle", async () => {
  const f = await fixture();
  try {
    const source = await skillBundle(f.root);
    await NodeFSP.mkdir(NodePath.join(source, "scripts/node_modules/typescript/lib"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(source, "scripts/node_modules/typescript/lib/tsc"),
      "a host binary\n",
    );
    await NodeFSP.mkdir(NodePath.join(source, ".git"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(source, ".git/HEAD"), "ref: refs/heads/main\n");
    await NodeFSP.writeFile(NodePath.join(source, "scripts/run.sh"), "echo hi\n");
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source, name: "pstack" }] },
    };
    const manifest = await f.store.freeze(input, config, f.resolver, f.profile);
    expect(homeFile(manifest, ".codex/skills/pstack/scripts/run.sh")?.sha256).toBe(
      provisionDigest("echo hi\n"),
    );
    expect(
      manifest.preparation.files.filter(
        (item) => item.destination.includes("node_modules") || item.destination.includes(".git/"),
      ),
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it("loads the configured skill bundle into the root the selected agent reads", async () => {
  const f = await fixture();
  try {
    const source = await skillBundle(f.root);
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source, name: "pstack" }] },
    };
    const manifest = await f.store.freeze(input, config, f.resolver, f.profile);
    // Codex is the default driver. A bundle is copied whole, because a
    // playbook that references a nested file is useless without that file.
    expect(homeFile(manifest, ".codex/skills/pstack/SKILL.md")?.sha256).toBe(
      provisionDigest("---\nname: pstack\n---\n"),
    );
    expect(homeFile(manifest, ".codex/skills/pstack/skills/why/SKILL.md")?.sha256).toBe(
      provisionDigest("why\n"),
    );
    // Never the checkout, which is what the agent opens a pull request from.
    expect(
      manifest.preparation.files.some(
        (item) => item.scope === "workspace" && item.destination.includes("skills"),
      ),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});

it("follows the selected agent when the same bundle is provisioned for Cursor", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.root, ".t3/userdata/cursor-homes/cursor/.cursor"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(f.root, ".t3/userdata/cursor-homes/cursor/.cursor/auth.json"),
      "cursor-fixture-credential",
    );
    const source = await skillBundle(f.root);
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source, name: "pstack" }] },
    };
    const cursorProfile: ProvisioningProviderProfile = {
      kind: "cursor",
      instanceId: ProviderInstanceId.make("cursor"),
      environment: [],
      credential: {
        kind: "file",
        source: NodePath.join(f.root, ".t3/userdata/cursor-homes/cursor/.cursor/auth.json"),
        destination: ".cursor/auth.json",
      },
    };
    const manifest = await f.store.freeze(
      inputFor("cursor", "cursor"),
      config,
      f.resolver,
      cursorProfile,
    );
    expect(homeFile(manifest, ".cursor/skills/pstack/SKILL.md")).toBeDefined();
    expect(homeFile(manifest, ".codex/skills/pstack/SKILL.md")).toBeUndefined();
    expect(homeFile(manifest, ".config/cursor/auth.json")?.sha256).toBe(
      provisionDigest("cursor-fixture-credential"),
    );
  } finally {
    await f.cleanup();
  }
});

it("runs a Cursor guest on the selected account, not a copied credential", async () => {
  const f = await fixture();
  try {
    const selected = NodePath.join(f.root, ".t3/userdata/cursor-homes/cursor_other/.cursor");
    await NodeFSP.mkdir(selected, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(selected, "auth.json"), "selected-account");
    await NodeFSP.mkdir(NodePath.join(f.root, ".cursor"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(f.root, ".cursor/auth.json"), "install-wide-account");
    const config = {
      ...f.config,
      provisioning: {
        ...f.config.provisioning!,
        // An operator who once pinned one account leaves this behind, and a
        // Linux guest reads exactly this path.
        homeFiles: [
          {
            source: NodePath.join(f.root, ".cursor/auth.json"),
            destination: ".config/cursor/auth.json",
          },
        ],
      },
    };
    const manifest = await f.store.freeze(inputFor("cursor", "cursor_other"), config, f.resolver, {
      kind: "cursor",
      instanceId: ProviderInstanceId.make("cursor_other"),
      environment: [],
      credential: {
        kind: "file",
        source: NodePath.join(selected, "auth.json"),
        // The manager resolves its own platform's path; the guest is Linux.
        destination: ".cursor/auth.json",
      },
    });
    expect(homeFile(manifest, ".config/cursor/auth.json")?.sha256).toBe(
      provisionDigest("selected-account"),
    );
    // A file at the macOS path is one the Linux CLI never reads, and one more
    // copy of a live login on the machine.
    expect(homeFile(manifest, ".cursor/auth.json")).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

it("installs a Claude sign-in where that CLI reads it", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.root, ".claude"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(f.root, ".claude/.credentials.json"),
      "claude-fixture-credential",
    );
    const source = await skillBundle(f.root);
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source, name: "pstack" }] },
    };
    const claudeProfile: ProvisioningProviderProfile = {
      kind: "claudeAgent",
      instanceId: ProviderInstanceId.make("claudeAgent"),
      environment: [],
      credential: {
        kind: "file",
        source: NodePath.join(f.root, ".claude/.credentials.json"),
        destination: ".claude/.credentials.json",
      },
    };
    const manifest = await f.store.freeze(
      inputFor("claudeAgent", "claudeAgent"),
      config,
      f.resolver,
      claudeProfile,
    );
    // Claude Code keeps a dotfile credential rather than the auth.json the
    // other drivers use, and its skills follow the same profile.
    expect(homeFile(manifest, ".claude/.credentials.json")?.sha256).toBe(
      provisionDigest("claude-fixture-credential"),
    );
    expect(homeFile(manifest, ".claude/skills/pstack/SKILL.md")).toBeDefined();
    expect(homeFile(manifest, ".codex/skills/pstack/SKILL.md")).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

it("gives a Claude account with a setup-token that token instead of a credential file", async () => {
  const f = await fixture();
  try {
    const manifest = await f.store.freeze(
      inputFor("claudeAgent", "claude_personal"),
      f.config,
      f.resolver,
      {
        kind: "claudeAgent",
        instanceId: ProviderInstanceId.make("claude_personal"),
        environment: [
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-cloud-only", sensitive: true },
        ],
        credential: { kind: "environment" },
      },
    );
    const settings = homeFile(manifest, ".t3/userdata/settings.json");
    expect(
      JSON.parse(Buffer.from(settings?.contentsBase64 ?? "", "base64").toString()).providerInstances
        .claudeAgent.environment,
    ).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-cloud-only", sensitive: true },
    ]);
    expect(homeFile(manifest, ".claude/.credentials.json")).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

it("drops a copied credential file that the cloud token replaces", async () => {
  const f = await fixture();
  try {
    await NodeFSP.mkdir(NodePath.join(f.root, ".claude"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(f.root, ".claude/.credentials.json"), "stale-login");
    await NodeFSP.writeFile(NodePath.join(f.root, ".gitignore-global"), "node_modules\n");
    const config = {
      ...f.config,
      provisioning: {
        ...f.config.provisioning!,
        homeFiles: [
          {
            source: NodePath.join(f.root, ".claude/.credentials.json"),
            destination: ".claude/.credentials.json",
          },
          { source: NodePath.join(f.root, ".codex/auth.json"), destination: ".codex/auth.json" },
          { source: NodePath.join(f.root, ".gitignore-global"), destination: ".gitignore-global" },
        ],
      },
    };
    const manifest = await f.store.freeze(
      inputFor("claudeAgent", "claude_personal"),
      config,
      f.resolver,
      {
        kind: "claudeAgent",
        instanceId: ProviderInstanceId.make("claude_personal"),
        environment: [
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-cloud-only", sensitive: true },
        ],
        credential: { kind: "environment" },
      },
    );
    expect(homeFile(manifest, ".claude/.credentials.json")).toBeUndefined();
    // Only the selected driver's login is replaced. Copying the others is why
    // homeFiles exists.
    expect(homeFile(manifest, ".codex/auth.json")?.sha256).toBe(
      provisionDigest("private-fixture-credential"),
    );
    expect(homeFile(manifest, ".gitignore-global")?.sha256).toBe(provisionDigest("node_modules\n"));
  } finally {
    await f.cleanup();
  }
});

it("hands a cloud box the setup its repository needs", async () => {
  const f = await fixture();
  try {
    const config = {
      ...f.config,
      provisioning: {
        ...f.config.provisioning!,
        repositories: [
          {
            repository: "example/repo",
            e2b: { prepareCommands: ["npm install --global vite-plus"] },
          },
          { repository: "example/other", e2b: { prepareCommands: ["never"] } },
        ],
      },
    };
    const manifest = await f.store.freeze(
      inputFor("codex", "codex"),
      config,
      f.resolver,
      f.profile,
    );
    expect(manifest.preparation.prepareCommands).toEqual(["npm install --global vite-plus"]);
    // A prepared checkout is a different machine from an unprepared one, so
    // two requests only match when their setup matches.
    const bare = await makeProvisionPreparationStore(f.root + "-bare").freeze(
      inputFor("codex", "codex"),
      f.config,
      f.resolver,
      f.profile,
    );
    expect(bare.request.buildHash).not.toBe(manifest.request.buildHash);
    await NodeFSP.rm(f.root + "-bare", { recursive: true, force: true });
  } finally {
    await f.cleanup();
  }
});

it("refuses a skill bundle that links out of itself", async () => {
  const f = await fixture();
  try {
    const source = await skillBundle(f.root);
    await NodeFSP.symlink(
      NodePath.join(f.root, ".codex/auth.json"),
      NodePath.join(source, "escape.json"),
    );
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source, name: "pstack" }] },
    };
    // A bundle is copied into an environment that then holds whatever it
    // names, so a link out of it is refused rather than resolved.
    await expect(f.store.freeze(input, config, f.resolver, f.profile)).rejects.toThrow(
      /escape\.json/,
    );
  } finally {
    await f.cleanup();
  }
});

it("carries a link that stays inside the bundle", async () => {
  const f = await fixture();
  try {
    const source = await skillBundle(f.root);
    await NodeFSP.mkdir(NodePath.join(source, "skills/.bin"), { recursive: true });
    // The shape npm leaves behind in a skill that has its own scripts.
    await NodeFSP.symlink("../why/SKILL.md", NodePath.join(source, "skills/.bin/why"));
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source, name: "pstack" }] },
    };
    const manifest = await f.store.freeze(input, config, f.resolver, f.profile);
    expect(homeFile(manifest, ".codex/skills/pstack/skills/.bin/why")?.sha256).toBe(
      provisionDigest("why\n"),
    );
  } finally {
    await f.cleanup();
  }
});

it("lands a plugin holding many skills flat, where the CLI will find each one", async () => {
  const f = await fixture();
  try {
    const source = NodePath.join(f.root, "bundles/pstack-skills");
    for (const name of ["why", "interrogate"]) {
      await NodeFSP.mkdir(NodePath.join(source, name), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    const config = {
      ...f.config,
      provisioning: { ...f.config.provisioning!, skills: [{ source }] },
    };
    const manifest = await f.store.freeze(input, config, f.resolver, f.profile);
    // Every supported CLI resolves `<root>/<directory>/SKILL.md` and looks no
    // deeper, so nesting these under a bundle name would hide all of them.
    expect(homeFile(manifest, ".codex/skills/why/SKILL.md")).toBeDefined();
    expect(homeFile(manifest, ".codex/skills/interrogate/SKILL.md")).toBeDefined();
  } finally {
    await f.cleanup();
  }
});
const namespaceToken = `e30.${Buffer.from(
  JSON.stringify({ actor_id: "user-test", tenant_id: "tenant-test", exp: 4102444800 }),
).toString("base64url")}.signature`;
it("roots a Namespace preparation on the retained Devbox volume and keeps E2B in /tmp", async () => {
  const f = await fixture();
  try {
    const e2b = await f.store.freeze(input, f.config, f.resolver, f.profile);
    expect(e2b.preparation.root).toBe("/tmp/t3-provision/05d43b4e-0b92-477b-9503-31a377147fb0");
    expect(e2b.preparation.artifact.archivePath).toBe(
      `/tmp/t3-runtime-${provisionDigest("artifact")}.tar`,
    );
    const artifact = f.config.provisioning?.runtimeArtifacts?.linux;
    if (!artifact) throw new Error("Fixture has no runtime artifact");
    const namespace = await f.store.freeze(
      decodeProvisionInput({
        ...input,
        requestId: "6b0e2d4f-1c3a-4e5b-8f7d-9a0b1c2d3e4f",
        provider: "namespace",
      }),
      {
        ...f.config,
        namespaceToken,
        provisioning: {
          ...f.config.provisioning,
          namespace: { size: "m" },
          runtimeArtifacts: { macos: artifact },
        },
      },
      f.resolver,
      f.profile,
    );
    expect(namespace.preparation.root).toBe(
      "/Volumes/devbox/t3-provision/6b0e2d4f-1c3a-4e5b-8f7d-9a0b1c2d3e4f",
    );
    expect(namespace.preparation.artifact.archivePath).toBe(
      `/Volumes/devbox/t3-runtime-${provisionDigest("artifact")}.tar`,
    );
    const settings = namespace.preparation.files.find(
      (file) => file.destination === ".t3/userdata/settings.json",
    );
    expect(
      JSON.parse(Buffer.from(settings?.contentsBase64 ?? "", "base64").toString()),
    ).toMatchObject({
      enableDeviceSupport: true,
      enableAgentDeviceAccess: true,
      providerInstances: {
        codex: {
          config: {
            homePath:
              "/Volumes/devbox/t3-provision/6b0e2d4f-1c3a-4e5b-8f7d-9a0b1c2d3e4f/home/.codex",
          },
        },
      },
    });
    const e2bSettings = e2b.preparation.files.find(
      (file) => file.destination === ".t3/userdata/settings.json",
    );
    const parsedE2bSettings = JSON.parse(
      Buffer.from(e2bSettings?.contentsBase64 ?? "", "base64").toString(),
    );
    expect(Object.prototype.hasOwnProperty.call(parsedE2bSettings, "enableDeviceSupport")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(parsedE2bSettings, "enableAgentDeviceAccess")).toBe(
      false,
    );
  } finally {
    await f.cleanup();
  }
});

it("hands a cloud Mac the artifacts configured for it, by identity rather than by URL", async () => {
  const f = await fixture();
  try {
    const baseline = {
      path: "baseline/xcode.tar.zst",
      destination: "baseline.tar.zst",
      sha256: "1".repeat(64),
    };
    const override = {
      path: "baseline/repo.tar.zst",
      destination: "repo.tar.zst",
      sha256: "2".repeat(64),
    };
    const config = {
      ...f.config,
      namespaceToken,
      provisioning: {
        ...f.config.provisioning!,
        namespace: { size: "m", artifacts: [baseline] },
        repositories: [{ repository: "example/other", namespace: { artifacts: [override] } }],
      },
    };
    const platform = await f.store.freeze(
      decodeProvisionInput({ ...input, provider: "namespace" }),
      config,
      f.resolver,
      f.profile,
    );
    expect(platform.preparation.artifacts).toEqual([baseline]);
    const repository = await makeProvisionPreparationStore(f.root + "-repo").freeze(
      decodeProvisionInput({
        ...input,
        requestId: "6b0e2d4f-1c3a-4e5b-8f7d-9a0b1c2d3e4f",
        provider: "namespace",
        repository: "example/other",
      }),
      config,
      f.resolver,
      f.profile,
    );
    expect(repository.preparation.artifacts).toEqual([override]);
    expect(repository.request.buildHash).not.toBe(platform.request.buildHash);
    const e2b = await makeProvisionPreparationStore(f.root + "-e2b").freeze(
      input,
      config,
      f.resolver,
      f.profile,
    );
    expect(e2b.preparation.artifacts).toBeUndefined();
  } finally {
    for (const suffix of ["-repo", "-e2b"])
      await NodeFSP.rm(f.root + suffix, { recursive: true, force: true });
    await f.cleanup();
  }
});

/**
 * Every account the guest could run a turn on, as its own provider registry
 * resolves them from the settings this preparation wrote. An enabled driver
 * contributes an implicit instance keyed by its driver kind, so reading the
 * written `providerInstances` map alone would miss an account the guest offers.
 */
function guestAccounts(
  manifest: Awaited<ReturnType<ReturnType<typeof makeProvisionPreparationStore>["freeze"]>>,
  driver: string,
) {
  const written = homeFile(manifest, ".t3/userdata/settings.json");
  const settings = decodeServerSettings(
    JSON.parse(Buffer.from(written?.contentsBase64 ?? "", "base64").toString()),
  );
  return Object.entries(deriveProviderInstanceConfigMap(settings))
    .filter(
      ([, instance]) =>
        instance.driver === driver &&
        (instance.enabled ?? (instance.config as { enabled?: boolean } | undefined)?.enabled),
    )
    .map(([instanceId, instance]) => ({
      instanceId,
      config: instance.config as Record<string, unknown> | undefined,
      environment: (instance.environment ?? []).map(({ name }) => name),
    }));
}

it("runs a named Claude account's chat on the token it installed, and carries no other account's key", async () => {
  const f = await fixture();
  try {
    await NodeFSP.writeFile(NodePath.join(f.root, "cursor-key"), "cursor-api-key\n");
    await NodeFSP.writeFile(NodePath.join(f.root, "linear-key"), "linear-api-key\n");
    const config = {
      ...f.config,
      provisioning: {
        ...f.config.provisioning!,
        shellEnvironment: [
          { name: "CURSOR_API_KEY", source: NodePath.join(f.root, "cursor-key") },
          { name: "LINEAR_API_KEY", source: NodePath.join(f.root, "linear-key") },
        ],
      },
    };
    const manifest = await f.store.freeze(
      inputFor("claudeAgent", "claude_acai13"),
      config,
      f.resolver,
      {
        kind: "claudeAgent",
        instanceId: ProviderInstanceId.make("claude_acai13"),
        environment: [
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-cloud-only", sensitive: true },
        ],
        credential: { kind: "environment" },
      },
    );
    // A guest holds one account. Offering a second, credential-less one is how
    // a turn reached the CLI with no login and failed on "Not logged in".
    expect(guestAccounts(manifest, "claudeAgent")).toEqual([
      {
        instanceId: "claudeAgent",
        config: undefined,
        // Another driver's key is not this account's to carry.
        environment: ["LINEAR_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      },
    ]);
    // One agent CLI is installed, so any other driver is a dead account.
    expect(guestAccounts(manifest, "codex")).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it("runs a named Codex account's chat on the provisioned home", async () => {
  const f = await fixture();
  try {
    const manifest = await f.store.freeze(
      inputFor("codex", "codex_andrewca78"),
      f.config,
      f.resolver,
      { ...f.profile, instanceId: ProviderInstanceId.make("codex_andrewca78") },
    );
    const accounts = guestAccounts(manifest, "codex");
    expect(accounts.length).toBe(1);
    expect(accounts[0]?.config?.homePath).toBe(`${manifest.preparation.root}/home/.codex`);
  } finally {
    await f.cleanup();
  }
});

it("names the guest's provider instance after the account the manager selected", async () => {
  const f = await fixture();
  try {
    const manifest = await f.store.freeze(input, f.config, f.resolver, {
      ...f.profile,
      displayName: "Codex · andrewcai083@gmail.com",
    });
    const settings = homeFile(manifest, ".t3/userdata/settings.json");
    expect(
      JSON.parse(Buffer.from(settings?.contentsBase64 ?? "", "base64").toString()).providerInstances
        .codex.displayName,
    ).toBe("Codex · andrewcai083@gmail.com");
  } finally {
    await f.cleanup();
  }
});

it("leaves the guest's provider instance unnamed when the manager has no display name for it", async () => {
  const f = await fixture();
  try {
    const manifest = await f.store.freeze(input, f.config, f.resolver, f.profile);
    const settings = homeFile(manifest, ".t3/userdata/settings.json");
    expect(
      Object.prototype.hasOwnProperty.call(
        JSON.parse(Buffer.from(settings?.contentsBase64 ?? "", "base64").toString())
          .providerInstances.codex,
        "displayName",
      ),
    ).toBe(false);
  } finally {
    await f.cleanup();
  }
});
