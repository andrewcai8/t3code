#!/usr/bin/env node
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { Sandbox, ApiClient, ConnectionConfig } = require("e2b");
const { values } = NodeUtil.parseArgs({
  options: {
    template: { type: "string" },
    config: {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".t3/environment-control.json"),
    },
    output: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/cloud/verify-e2b-common-template.mjs --template ID --output FILE [--config FILE]",
  );
  console.log(
    "Creates one owned sandbox, verifies the clean tool baseline and process retention, then deletes that sandbox.",
  );
  process.exit(0);
}
if (!values.template || !values.output) throw new Error("--template and --output are required");
const config = JSON.parse(await NodeFSP.readFile(values.config, "utf8"));
if (typeof config.e2bApiKey !== "string" || !config.e2bApiKey)
  throw new Error("E2B API key is missing");
const api = { apiKey: config.e2bApiKey, requestTimeoutMs: 30_000 };
const owner = NodeCrypto.randomUUID();
const proof = {
  templateId: values.template,
  owner,
  startedAt: new Date().toISOString(),
  checks: [],
};
const record = async (check, details = {}) => {
  const result = { check, ...details };
  proof.checks.push(result);
  await NodeFSP.writeFile(values.output, JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
};
const templateResponse = await new ApiClient(new ConnectionConfig(api)).api.GET(
  "/templates/{templateID}",
  {
    params: { path: { templateID: values.template } },
  },
);
NodeAssert.equal(templateResponse.data?.public, false, "template must be private");
await record("template is private");
let sandbox;
const owned = async () => {
  NodeAssert.ok(sandbox);
  const info = await Sandbox.getInfo(sandbox.sandboxId, api);
  NodeAssert.equal(info.sandboxId, sandbox.sandboxId);
  NodeAssert.equal(info.metadata.purpose, "t3-common-tools-verification");
  NodeAssert.equal(info.metadata.owner, owner);
  return info;
};
const run = async (command, timeoutMs = 120_000) => {
  const result = await sandbox.commands.run(command, { timeoutMs });
  NodeAssert.equal(result.exitCode, 0);
  return result.stdout.trim();
};
try {
  const started = performance.now();
  sandbox = await Sandbox.create(values.template, {
    ...api,
    timeoutMs: 600_000,
    lifecycle: { onTimeout: "pause", autoResume: false },
    metadata: { purpose: "t3-common-tools-verification", owner },
  });
  const info = await owned();
  NodeAssert.equal(info.cpuCount, 4);
  NodeAssert.equal(info.memoryMB, 8192);
  await record("fresh owned sandbox created", {
    sandboxId: sandbox.sandboxId,
    durationMs: Math.round(performance.now() - started),
    cpuCount: info.cpuCount,
    memoryMB: info.memoryMB,
  });
  const tools = await run(
    "bash /opt/t3-common-tools.sh verify && git --version && gh --version && rg --version && python3 --version && redis-server --version && go version && ruby --version",
  );
  await record("tools and Swift compilation passed without credentials or state", {
    output: tools,
  });
  await run(
    'python3 -c \'import os; assert not any(os.environ.get(key) for key in ["E2B_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"])\'',
  );
  await record("no host or provider credentials in guest environment");
  await run("mkdir -p /tmp/t3-common-vp");
  await sandbox.files.write(
    "/tmp/t3-common-vp/package.json",
    JSON.stringify({
      name: "t3-common-vp-proof",
      private: true,
      scripts: { proof: "node -e 'process.stdout.write(String(6*7))'" },
    }),
  );
  NodeAssert.match(await run("cd /tmp/t3-common-vp && vp run proof"), /(?:^|\n)42(?:\n|$)/);
  await run(
    'redis-server --port 0 --unixsocket /tmp/t3-common-redis.sock --daemonize yes --pidfile /tmp/t3-common-redis.pid --logfile /tmp/t3-common-redis.log && test "$(redis-cli -s /tmp/t3-common-redis.sock ping)" = PONG && redis-cli -s /tmp/t3-common-redis.sock shutdown nosave',
  );
  await record("vp executed a package script and disposable Redis answered PING");
  await run(
    "env -i HOME=/home/user PATH=/home/user/.local/bin:/home/user/.bun/bin:/usr/local/bin:/usr/bin:/bin bash -c 'test \"$(bun --version)\" = 1.4.0; swift --version; vp --version; agent --version; python3 -m venv /tmp/t3-clean-venv; rm -rf /tmp/t3-clean-venv'",
  );
  await run(
    'env -i HOME=/home/user PATH=/usr/bin:/bin bash -lc \'test "$(bun --version)" = 1.4.0; swift --version; agent --version; test "$(npm config get prefix)" = /home/user/.local\'',
  );
  await record("selected-provider PATH and fresh login shell passed");
  await run(
    "test -z \"$(ss -H -ltn 'sport = :3000 or sport = :3001')\"; test ! -d /home/user/work",
  );
  await record("no T3 listener or repository checkout");
  const nonce = NodeCrypto.randomUUID();
  await sandbox.files.write("/tmp/t3-common-sentinel", nonce);
  const retained = await sandbox.commands.run("sleep 10000", { background: true, timeoutMs: 0 });
  const startTicks = await run(
    `python3 -c 'print(open("/proc/${retained.pid}/stat").read().split()[21])'`,
  );
  await owned();
  await sandbox.pause();
  NodeAssert.equal((await owned()).state, "paused");
  const resumeStarted = performance.now();
  sandbox = await Sandbox.connect(sandbox.sandboxId, { ...api, timeoutMs: 600_000 });
  NodeAssert.equal((await owned()).state, "running");
  NodeAssert.equal(await sandbox.files.read("/tmp/t3-common-sentinel"), nonce);
  NodeAssert.equal(
    await run(`python3 -c 'print(open("/proc/${retained.pid}/stat").read().split()[21])'`),
    startTicks,
  );
  await run(
    'test "$(bun --version)" = 1.4.0 && swift --version && codex --version && agent --version',
  );
  await record("pause/resume retained process, sentinel, and tools", {
    durationMs: Math.round(performance.now() - resumeStarted),
    pid: retained.pid,
    startTicks,
  });
} catch (error) {
  await record("verification failed", { name: String(error?.name ?? "Error") });
  const diagnostic = JSON.stringify({
    message: String(error?.message ?? "Unknown verification failure"),
    stdout: String(error?.stdout ?? ""),
    stderr: String(error?.stderr ?? ""),
  }).replaceAll(api.apiKey, "[redacted]");
  await NodeFSP.writeFile(`${values.output}.failure.log`, diagnostic, { mode: 0o600 });
  process.exitCode = 1;
} finally {
  if (sandbox) {
    await owned();
    await sandbox.kill();
    await record("owned verification sandbox deleted", { sandboxId: sandbox.sandboxId });
  }
}
