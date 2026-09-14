// @effect-diagnostics nodeBuiltinImport:off - tests exercise private immutable filesystem inputs.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { EnvironmentProvisionInput, ProvisionRequestConflict } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { makeProvisionPreparationStore, provisionDigest } from "./ProvisionPreparation.ts";
import type { EnvironmentControlConfig } from "./config.ts";
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
  return {
    root,
    config,
    store: makeProvisionPreparationStore(root),
    resolver: { template: async () => "canonical-template", revision: async () => "a".repeat(40) },
    cleanup: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}
it("freezes source, template, artifact and credentials across manager restart and rejects changed intent", async () => {
  const f = await fixture();
  try {
    const first = await f.store.freeze(input, f.config, f.resolver, f.root);
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
      f.root,
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
      f.store.freeze({ ...input, branch: "other" }, f.config, f.resolver, f.root),
    ).rejects.toBeInstanceOf(ProvisionRequestConflict);
    await expect(
      f.store.freeze(
        { ...input, retentionDeadline: "2099-01-02T00:00:00.000Z" },
        f.config,
        f.resolver,
        f.root,
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
          f.root,
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
        f.root,
      ),
    ).rejects.toThrow("hash check");
    await expect(
      f.store.freeze(
        { ...input, workspaceFiles: [{ ...evidence, destination: "../secret" }] },
        f.config,
        f.resolver,
        f.root,
      ),
    ).rejects.toThrow("relative path");
    await expect(
      f.store.freeze(
        { ...input, workspaceFiles: [evidence, evidence] },
        f.config,
        f.resolver,
        f.root,
      ),
    ).rejects.toThrow("duplicate");
    await expect(
      f.store.freeze(
        input,
        { ...f.config, provisioning: { templateId: "old" } },
        f.resolver,
        f.root,
      ),
    ).rejects.toThrow("pinned runtime artifact");
    const empty = await f.store.freeze(
      { ...input, repository: undefined },
      f.config,
      f.resolver,
      f.root,
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
    const first = await f.store.freeze(input, f.config, f.resolver, f.root);
    const path = NodePath.join(f.root, "provisioning", `${input.requestId}.json`);
    await NodeFSP.writeFile(path, JSON.stringify({ ...first, egressAllow: ["changed.example"] }), {
      mode: 0o600,
    });
    await expect(f.store.freeze(input, f.config, f.resolver, f.root)).rejects.toThrow(
      "Stored preparation manifest changed",
    );
  } finally {
    await f.cleanup();
  }
});
