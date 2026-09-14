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
import { makeProvisionPreparationStore, provisionDigest } from "./ProvisionPreparation.ts";
import type { EnvironmentControlConfig } from "./config.ts";
import type { ProvisioningProviderProfile } from "./ProvisioningProviderProfile.ts";
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
        destination: ".config/cursor/auth.json",
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
      /symbolic link/,
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
