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

const output = process.argv[2];
if (!output) throw new Error("Usage: build-runtime-artifact.ts <output.tar>");

const repoRoot = NodePath.resolve(new URL("../../..", import.meta.url).pathname);
const workspace = Schema.decodeUnknownSync(fromYaml(WorkspaceConfig))(
  await NodeFSP.readFile(NodePath.join(repoRoot, "pnpm-workspace.yaml"), "utf8"),
);
const stage = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-runtime-artifact-"));
try {
  await NodeFSP.cp(NodePath.join(repoRoot, "apps/server/dist"), NodePath.join(stage, "dist"), {
    recursive: true,
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
  const archive = NodeChildProcess.spawnSync(
    "tar",
    ["-cf", NodePath.resolve(output), "-C", stage, "."],
    {
      stdio: "inherit",
    },
  );
  if (archive.status !== 0) throw new Error("tar could not write the runtime artifact");
} finally {
  await NodeFSP.rm(stage, { recursive: true, force: true });
}
