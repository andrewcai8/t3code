#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { COMMON_TOOLS_BASE, COMMON_TOOLS_STEPS } from "./common-tools-image.mjs";

const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { Template } = require("e2b");
const { values } = NodeUtil.parseArgs({
  options: {
    name: { type: "string", default: "t3-common-tools-node24-bun140-v8" },
    "cpu-count": { type: "string", default: "8" },
    config: {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".t3/environment-control.json"),
    },
    output: { type: "string" },
    "print-dockerfile": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/cloud/build-e2b-common-template.mjs --output DIRECTORY [--name NAME] [--cpu-count N] [--config FILE] [--print-dockerfile]",
  );
  console.log(
    "Builds a clean private E2B template with --cpu-count vCPUs (default 8, the E2B Pro maximum), 8 GiB RAM, 8 GiB swap and 50 GiB free disk. Copies only the public installer recipe. Does not change environment-control configuration.",
  );
  process.exit(0);
}
const cpuCount = Number(values["cpu-count"]);
if (!Number.isInteger(cpuCount) || cpuCount < 1)
  throw new Error("--cpu-count must be a positive integer");

const template = COMMON_TOOLS_STEPS.reduce(
  (built, step) => {
    if ("user" in step) return built.setUser(step.user);
    if ("copy" in step) return built.copy(step.copy, step.to, { mode: step.mode });
    if ("env" in step) return built.setEnvs(step.env);
    if ("workdir" in step) return built.setWorkdir(step.workdir);
    return built.runCmd(step.run);
  },
  Template({
    fileContextPath: NodeURL.fileURLToPath(new URL("./", import.meta.url)),
  }).fromImage(COMMON_TOOLS_BASE),
)
  // Sandboxes resume from the VM that ran the start command, not the build-step VM,
  // so the swapon belongs in the start command.
  .runCmd("sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile")
  .setStartCmd("sudo swapon /swapfile", "grep -q '^/swapfile ' /proc/swaps");

if (values["print-dockerfile"]) {
  console.log(Template.toDockerfile(template));
  process.exit(0);
}
if (!values.output) throw new Error("--output DIRECTORY is required for build evidence");
const output = NodePath.resolve(values.output);
await NodeFSP.mkdir(output, { recursive: true, mode: 0o700 });
const config = JSON.parse(await NodeFSP.readFile(values.config, "utf8"));
if (typeof config.e2bApiKey !== "string" || !config.e2bApiKey)
  throw new Error("E2B API key is missing");
const apiKey = config.e2bApiKey;
const startedAt = new Date().toISOString();
const started = performance.now();
await NodeFSP.writeFile(NodePath.join(output, "Dockerfile"), Template.toDockerfile(template));
const log = await NodeFSP.open(NodePath.join(output, "build.log"), "a", 0o600);
try {
  const result = await Template.build(template, values.name, {
    apiKey,
    cpuCount,
    memoryMB: 8192,
    minFreeDiskMb: 51200,
    onBuildLogs: (entry) => {
      const line = JSON.stringify(entry).replaceAll(apiKey, "[redacted]");
      NodeFS.writeSync(log.fd, `${line}\n`);
      if (
        /^(Template created|\[builder \d+\/\d+\] (RUN|CACHED)|Build finished)/.test(entry.message)
      )
        console.log(line);
    },
  });
  const evidence = {
    ...result,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    cpuCount,
    memoryMB: 8192,
  };
  await NodeFSP.writeFile(NodePath.join(output, "build.json"), JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(evidence));
} catch (error) {
  const message = String(error?.message ?? "Unknown build failure").replaceAll(
    apiKey,
    "[redacted]",
  );
  await log.write(`${JSON.stringify({ failed: true, message })}\n`);
  console.error(`E2B template build failed. Private log: ${NodePath.join(output, "build.log")}`);
  process.exitCode = 1;
} finally {
  await log.close();
}
