// @effect-diagnostics nodeBuiltinImport:off - packs real files and unpacks the real tarball.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { packHostState, writeSeedArchive, type HostConfig } from "./pack-host-state.ts";

const fixture = async (
  extra: Pick<HostConfig, "namespaceToken"> = {},
  namespaceSession?: string,
  namespaceFederated?: boolean,
) => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pack-host-state-"));
  const write = async (path: string, data: string) => {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(home, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(home, path), data);
  };
  await write(".codex/auth.json", '{"token":"codex"}');
  await write("secrets/github.bin", "gh-secret");
  await write("plugins/review-skills/review/SKILL.md", "# Review\n");
  if (namespaceSession !== undefined) await write("ns/token.json", namespaceSession);
  const packed = await packHostState({
    config: {
      e2bApiKey: "e2b-key",
      ...extra,
      provisioning: {
        templateId: "t3-common",
        runtimeArtifacts: {
          macos: {
            path: NodePath.join(home, "runtime-macos.tar.gz"),
            sha256: "0".repeat(64),
            revision: "1".repeat(40),
            entrypoint: "dist/bin.mjs",
            runtimeExecutable: "node",
            install: "npm",
          },
        },
        egressAllow: ["registry.npmjs.org"],
        namespace: { size: "m" },
        repositories: [
          {
            repository: "acme/ios",
            workspaceFiles: [{ source: NodePath.join(home, "ios.env"), destination: ".env" }],
            namespace: { prepareCommands: ["pod install"] },
          },
          { repository: "acme/web", e2b: { prepareCommands: ["npm ci"] } },
        ],
        claudeOAuthTokens: { claude_work: "sk-ant-oat01-work" },
        shellEnvironment: [{ name: "GH_TOKEN", source: NodePath.join(home, "secrets/github.bin") }],
        skills: [{ source: NodePath.join(home, "plugins/review-skills"), name: "review" }],
      },
    },
    settings: {
      providerInstances: {
        codex: { driver: "codex", enabled: true },
        claude_work: { driver: "claudeAgent", displayName: "Claude · work" },
      },
    },
    host: { homedir: home, platform: "linux", environment: {} },
    baseDir: "/data/t3",
    skillsDir: "/data/t3/skills",
    namespaceSession:
      namespaceSession === undefined ? undefined : NodePath.join(home, "ns/token.json"),
    namespaceFederated,
  });
  return { home, packed };
};

const extractSeed = async (home: string, state: Awaited<ReturnType<typeof packHostState>>) => {
  const output = NodePath.join(home, "seed.tgz");
  await writeSeedArchive({
    state,
    baseDir: "/data/t3",
    output,
    broker: {
      sandboxId: "none",
      metadata: { purpose: "t3-environment", account: "aws-host" },
      url: "https://host.example",
      ingressKey: "ingress-test",
    },
  });
  const extracted = NodePath.join(home, "extracted");
  await NodeFSP.mkdir(extracted);
  NodeChildProcess.execFileSync("tar", ["-xzf", output, "-C", extracted]);
  return extracted;
};

describe("packHostState", () => {
  it("places every file and config path under the base dir, leaving Namespace without a token", async () => {
    const { home, packed } = await fixture();
    try {
      assert.deepEqual(packed.accounts, ["codex", "claude_work"]);
      assert.deepEqual(
        packed.files.map((file) => [file.path, String(file.data)]),
        [
          [
            "/data/t3/userdata/settings.json",
            JSON.stringify({
              enableProviderUpdateChecks: false,
              providerInstances: {
                codex: {
                  driver: "codex",
                  enabled: true,
                  config: { homePath: "/data/t3/codex-homes/codex" },
                },
                claude_work: {
                  driver: "claudeAgent",
                  displayName: "Claude · work",
                  enabled: true,
                  environment: [
                    {
                      name: "CLAUDE_CODE_OAUTH_TOKEN",
                      value: "sk-ant-oat01-work",
                      sensitive: true,
                    },
                  ],
                },
              },
            }),
          ],
          ["/data/t3/codex-homes/codex/auth.json", '{"token":"codex"}'],
          ["/data/t3/shell-environment/GH_TOKEN", "gh-secret"],
        ],
      );
      assert.deepEqual(packed.config, {
        e2bApiKey: "e2b-key",
        targets: [],
        provisioning: {
          templateId: "t3-common",
          egressAllow: ["registry.npmjs.org"],
          shellEnvironment: [{ name: "GH_TOKEN", source: "/data/t3/shell-environment/GH_TOKEN" }],
          skills: [{ source: "/data/t3/skills/0/review-skills", name: "review" }],
        },
      });
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it("carries Namespace settings with a namespaceToken, but no runtime artifact", async () => {
    const { home, packed } = await fixture({ namespaceToken: "nsc-token" });
    try {
      assert.deepEqual(packed.config, {
        e2bApiKey: "e2b-key",
        namespaceToken: "nsc-token",
        targets: [],
        provisioning: {
          templateId: "t3-common",
          egressAllow: ["registry.npmjs.org"],
          shellEnvironment: [{ name: "GH_TOKEN", source: "/data/t3/shell-environment/GH_TOKEN" }],
          skills: [{ source: "/data/t3/skills/0/review-skills", name: "review" }],
          namespace: { size: "m" },
          repositories: [
            { repository: "acme/ios", namespace: { prepareCommands: ["pod install"] } },
          ],
        },
      });
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it("carries a Namespace login session as a private ns/token.json with Namespace settings", async () => {
    const { home, packed } = await fixture(
      {},
      '{"session_token":"st_test","bearer_token":"nsct_stale"}',
    );
    try {
      assert.deepEqual(packed.files.at(-1), {
        path: "/data/t3/ns/token.json",
        data: '{"session_token":"st_test"}',
      });
      assert.deepEqual(packed.config, {
        e2bApiKey: "e2b-key",
        targets: [],
        provisioning: {
          templateId: "t3-common",
          egressAllow: ["registry.npmjs.org"],
          shellEnvironment: [{ name: "GH_TOKEN", source: "/data/t3/shell-environment/GH_TOKEN" }],
          skills: [{ source: "/data/t3/skills/0/review-skills", name: "review" }],
          namespace: { size: "m" },
          repositories: [
            { repository: "acme/ios", namespace: { prepareCommands: ["pod install"] } },
          ],
        },
      });
      const extracted = await extractSeed(home, packed);
      const token = NodePath.join(extracted, "ns/token.json");
      assert.equal(await NodeFSP.readFile(token, "utf8"), '{"session_token":"st_test"}');
      assert.equal((await NodeFSP.stat(token)).mode & 0o777, 0o600);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });

  it("carries Namespace settings with no credential for a federated host", async () => {
    const { home, packed } = await fixture({}, undefined, true);
    try {
      assert.isFalse(packed.files.some((file) => file.path.endsWith("/ns/token.json")));
      assert.isUndefined(packed.config.namespaceToken);
      assert.deepEqual(packed.config.provisioning.namespace, { size: "m" });
      assert.deepEqual(packed.config.provisioning.repositories, [
        { repository: "acme/ios", namespace: { prepareCommands: ["pod install"] } },
      ]);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
    // A packed credential would shadow or replace the host's own token file.
    const conflict = await fixture({ namespaceToken: "nsc-token" }, undefined, true).then(
      () => "resolved",
      (error: Error) => error.message,
    );
    assert.include(conflict, "--namespace-federated");
  });

  it("rejects a Namespace session file without quoting it", async () => {
    const rejection = async (contents: string) => {
      try {
        await fixture({}, contents);
        return "resolved";
      } catch (error) {
        return (error as Error).message.replace(/^.*\/ns\/token\.json/, "<file>");
      }
    };
    assert.equal(await rejection("st_secret"), "<file> is not a Namespace token.json");
    assert.equal(
      await rejection('{"bearer_token":"nsct_secret"}'),
      "<file> has no session_token; run `nsc login`",
    );
  });

  it("writes a seed tarball rooted at the base dir with private files", async () => {
    const { home, packed } = await fixture();
    try {
      const extracted = await extractSeed(home, packed);
      const entries = (await NodeFSP.readdir(extracted, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => NodePath.relative(extracted, NodePath.join(entry.parentPath, entry.name)))
        .toSorted();
      assert.deepEqual(entries, [
        "codex-homes/codex/auth.json",
        "environment-control.base.json",
        "shell-environment/GH_TOKEN",
        "skills/0/review-skills/review/SKILL.md",
        "userdata/settings.json",
      ]);
      const config = JSON.parse(
        await NodeFSP.readFile(NodePath.join(extracted, "environment-control.base.json"), "utf8"),
      );
      assert.equal(config.broker.url, "https://host.example");
      assert.equal(config.provisioning.runtimeArtifacts, undefined);
      const mode = (await NodeFSP.stat(NodePath.join(extracted, "codex-homes/codex/auth.json")))
        .mode;
      assert.equal(mode & 0o777, 0o600);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});
