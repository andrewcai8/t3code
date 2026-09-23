#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a build script runs on the manager, outside any Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import packageJson from "../package.json" with { type: "json" };
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const args = process.argv.slice(2);
const output = args.find((arg) => !arg.startsWith("--"));
const install = args.includes("--install");
const platform = args.find((arg) => arg.startsWith("--platform="))?.slice("--platform=".length);
if (!output) {
  throw new Error(
    "Usage: build-runtime-artifact.ts <output.tar> [--install] [--platform=<docker platform>]",
  );
}
if (platform && !install) {
  throw new Error("--platform requires --install so native addons can be compiled for that OS");
}

const repoRoot = NodePath.resolve(new URL("../../..", import.meta.url).pathname);
const workspace = Schema.decodeUnknownSync(fromYaml(WorkspaceConfig))(
  await NodeFSP.readFile(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
);
const stage = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-artifact-"));
try {
  // This script packages `dist`, it does not build it. Shipping a dist older
  // than the sources it came from produces a manager that silently does not
  // match the code you are reading, which is indistinguishable from a bug in
  // the code itself.
  const distEntry = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
  const builtAt = (await NodeFSP.stat(distEntry)).mtimeMs;
  const sourceRoot = NodePath.join(repoRoot, "apps/server/src");
  const newestSource = async (directory: string): Promise<number> => {
    let newest = 0;
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = NodePath.join(directory, entry.name);
      const at = entry.isDirectory()
        ? await newestSource(full)
        : (await NodeFSP.stat(full)).mtimeMs;
      if (at > newest) newest = at;
    }
    return newest;
  };
  if ((await newestSource(sourceRoot)) > builtAt)
    throw new Error(
      "apps/server/dist is older than apps/server/src; run `vp run --filter t3 build` first",
    );
  // Source maps are two thirds of the archive and nothing on a provisioned
  // guest reads them: the stack traces we debug come from the manager's own
  // dist. Every megabyte here is uploaded again on every cold start.
  await NodeFSP.cp(NodePath.join(repoRoot, "apps/server/dist"), NodePath.join(stage, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map"),
  });
  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    bin: packageJson.bin,
    engines: packageJson.engines,
    files: packageJson.files,
    dependencies: resolveCatalogDependencies(
      packageJson.dependencies,
      workspace.catalog ?? {},
      "apps/server",
    ),
  };
  await NodeFSP.writeFile(
    NodePath.join(stage, "package.json"),
    `${JSON.stringify(runtimePackage, null, 2)}\n`,
  );
  const lock = NodeChildProcess.spawnSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: stage, stdio: "inherit" },
  );
  if (lock.status !== 0) throw new Error("npm could not resolve the runtime artifact lockfile");
  if (install) {
    if (platform) {
      // E2B templates are linux/amd64. Compile node-pty here so the sandbox
      // never fetches Node headers from nodejs.org (often egress-blocked).
      const docker = NodeChildProcess.spawnSync(
        "docker",
        [
          "run",
          "--rm",
          `--platform=${platform}`,
          "-v",
          `${stage}:/src`,
          "-w",
          "/src",
          "-e",
          "npm_config_update_notifier=false",
          "-e",
          "npm_config_ignore_scripts=false",
          "node:24.20.0-bookworm",
          "bash",
          "-lc",
          [
            "set -euo pipefail",
            "apt-get update -qq",
            "DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++",
            "npm ci --omit=dev --no-audit --no-fund --foreground-scripts",
            "rm -rf node_modules/node-pty/prebuilds/darwin-* node_modules/node-pty/prebuilds/win32-*",
            "rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl",
            "rm -rf node_modules/@ff-labs/fff-bin-linux-x64-musl",
            "rm -rf node_modules/@yuuang/ffi-rs-linux-x64-musl",
            "find . -name '*.map' -delete",
            "test -f node_modules/node-pty/build/Release/pty.node",
            // The container runs as root. On Linux the bind mount keeps that
            // ownership, and the caller could not delete its own stage.
            `chown -R ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /src`,
          ].join("; "),
        ],
        { stdio: "inherit" },
      );
      if (docker.status !== 0) {
        throw new Error(`docker could not install the runtime artifact for ${platform}`);
      }
    } else {
      const ci = NodeChildProcess.spawnSync(
        "npm",
        ["ci", "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: stage, stdio: "inherit" },
      );
      if (ci.status !== 0) throw new Error("npm could not install the runtime artifact");
    }
  }
  // A `.gz` output is gzipped. Python's tarfile sniffs compression, so a guest
  // extracts either form unchanged, and the compressed one crosses a home
  // upstream several times faster.
  const archive = NodeChildProcess.spawnSync(
    "tar",
    [output.endsWith(".gz") ? "-czf" : "-cf", NodePath.resolve(output), "-C", stage, "."],
    {
      stdio: "inherit",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  if (archive.status !== 0) throw new Error("tar could not write the runtime artifact");
} finally {
  await NodeFSP.rm(stage, { recursive: true, force: true });
}
