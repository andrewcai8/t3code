#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import { packHostState } from "./pack-host-state.ts";

const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { Sandbox } = require("e2b");

const { values } = NodeUtil.parseArgs({
  options: {
    config: {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".t3/environment-control.json"),
    },
    settings: {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".t3/userdata/settings.json"),
    },
    accounts: { type: "string" },
    output: { type: "string" },
    artifact: { type: "string" },
    port: { type: "string", default: "3775" },
    account: { type: "string", default: "provision-manager" },
    sandbox: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/cloud/deploy-provision-manager.mjs --output DIRECTORY [--config FILE]\n" +
      "       [--settings FILE] [--accounts ID,ID,...] [--artifact FILE] [--port PORT]\n" +
      "       [--account NAME] [--sandbox ID]\n\n" +
      "Stands up a provisioning manager in E2B. The manager runs the pinned runtime\n" +
      "artifact, never the template's published t3, which is upstream's build and does\n" +
      "not carry this fork's provisioning code. Builds the artifact when --artifact is\n" +
      "absent. Carries every provider account the host can provision on, or only those\n" +
      "named by --accounts. Writes a descriptor and the manager's own config to --output.",
  );
  process.exit(0);
}
if (!values.output) throw new Error("--output DIRECTORY is required");

const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const output = NodePath.resolve(values.output);
await NodeFSP.mkdir(output, { recursive: true, mode: 0o700 });

const config = JSON.parse(await NodeFSP.readFile(values.config, "utf8"));

const MANAGER_BASE_DIR = "/home/user/manager-state";
// A TTL, not an idle timer: E2B pauses the manager this long after creation
// and again after each auto-resume, however busy it is. Long enough that one
// wake covers a provision (about a minute) and a child's bootstrap with room
// to spare; short enough that a manager nobody is using pauses within the
// hour instead of billing for a day. Paused, it costs nothing and the next
// request wakes it in well under a second.
const MANAGER_TIMEOUT_MS = 30 * 60_000;

// Packing reads every credential before paying for a sandbox, so a missing
// file fails here rather than stranding a half-built box.
const state = await packHostState({
  config,
  settings: JSON.parse(await NodeFSP.readFile(values.settings, "utf8")),
  accounts: values.accounts
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Deploy script has no Effect runtime.
  host: { homedir: NodeOS.homedir(), platform: process.platform, environment: process.env },
  baseDir: MANAGER_BASE_DIR,
  skillsDir: "/home/user/skills",
});
for (const { id, reason } of state.skipped) console.log(`skipping ${id}: ${reason}`);
console.log(`carrying accounts ${state.accounts.join(", ")}`);
const { e2bApiKey: apiKey, provisioning } = state.config;
const templateId = provisioning.templateId;

let artifactPath = values.artifact;
if (!artifactPath) {
  artifactPath = NodePath.join(output, "runtime-linux.tar");
  console.log("building the runtime artifact");
  const build = NodeChildProcess.spawnSync(
    "node",
    ["apps/server/scripts/build-runtime-artifact.ts", artifactPath],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (build.status !== 0) throw new Error("building the runtime artifact failed");
}
const artifact = await NodeFSP.readFile(artifactPath);
const sha256 = NodeCrypto.createHash("sha256").update(artifact).digest("hex");
const revision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
  .toString()
  .trim();

// Reusing a sandbox matters on a retry: the artifact upload is the slow step,
// and a failure part way through would otherwise strand the box it created.
// The manager pauses when its timeout lapses and any request wakes it, which
// is what lets it create boxes while the operator's laptop is asleep. Without
// auto-resume a paused manager answers 502 until something connects to it.
// A websocket alone is enough: measured against a paused manager, an rpc
// client that opens a socket with no prior fetch got its answer back in 1.4s
// to 2.0s across three attempts. So no client needs a wake-up request first.
const sandbox = values.sandbox
  ? await Sandbox.connect(values.sandbox, { apiKey, timeoutMs: MANAGER_TIMEOUT_MS })
  : await Sandbox.create(templateId, {
      apiKey,
      timeoutMs: MANAGER_TIMEOUT_MS,
      lifecycle: { onTimeout: "pause", autoResume: true },
      metadata: { purpose: "t3-environment", account: values.account },
    });
if (values.sandbox) {
  // Lifecycle is fixed at creation; a box from before auto-resume existed
  // would deploy fine and then sleep through every request.
  const info = await sandbox.getInfo();
  if (info.lifecycle?.onTimeout !== "pause" || !info.lifecycle.autoResume)
    throw new Error(
      `Sandbox ${sandbox.sandboxId} cannot auto-resume; create a new manager instead`,
    );
}
console.log(
  values.sandbox
    ? `reusing manager sandbox ${sandbox.sandboxId}`
    : `created a manager from template ${templateId}`,
);
const port = Number(values.port);
const host = sandbox.getHost(port);

const managerConfig = {
  ...state.config,
  provisioning: {
    ...provisioning,
    runtimeArtifacts: {
      linux: {
        path: "/home/user/runtime-linux.tar",
        sha256,
        revision,
        entrypoint: "dist/bin.mjs",
        runtimeExecutable: "node",
        install: "npm",
      },
    },
  },
  broker: {
    sandboxId: sandbox.sandboxId,
    metadata: { purpose: "t3-environment", account: values.account },
    url: `https://${host}`,
    ingressKey: `ingress-${NodeCrypto.randomUUID()}`,
  },
};

// A previous deploy's accounts must not outlive the settings that named them.
await sandbox.commands.run(
  `rm -rf ${MANAGER_BASE_DIR}/codex-homes ${MANAGER_BASE_DIR}/cursor-homes ${MANAGER_BASE_DIR}/shell-environment`,
  { timeoutMs: 30_000 },
);
const privateFiles = [
  { path: "/home/user/environment-control.json", data: JSON.stringify(managerConfig) },
  ...state.files,
];
await sandbox.files.write(privateFiles);
// The runtime artifact is hundreds of megabytes; the SDK's default request
// timeout aborts the upload part way and leaves the sandbox half-built.
await sandbox.files.write("/home/user/runtime-linux.tar", artifact, {
  requestTimeoutMs: 1_800_000,
});
for (const [index, bundle] of state.skills.entries())
  await sandbox.files.write(`/home/user/skills-${index}.tgz`, bundle.archive);

console.log("installing the runtime artifact");
const install = await sandbox.commands.run(
  [
    "set -eu",
    `chmod 600 ${privateFiles.map((file) => `'${file.path}'`).join(" ")}`,
    ...state.skills.map(
      (bundle, index) =>
        `mkdir -p ${bundle.directory} && tar -xzf /home/user/skills-${index}.tgz -C ${bundle.directory}`,
    ),
    "rm -rf /home/user/manager && mkdir -p /home/user/manager",
    "tar -xf /home/user/runtime-linux.tar -C /home/user/manager",
    "cd /home/user/manager && npm install --omit=dev --no-audit --no-fund >/home/user/manager-install.log 2>&1",
    "echo installed",
  ].join(" && "),
  { timeoutMs: 900_000 },
);
if (!install.stdout.includes("installed")) throw new Error("Runtime artifact install failed");

// A reused sandbox is already serving on this port, and the replacement would
// fail to bind and die silently, leaving the previous build answering requests.
// Deploying then looked like a no-op: new artifact on disk, old code running.
// The bracket keeps the pattern from matching the shell that carries it.
await sandbox.commands.run(
  "pkill -f '[m]anager/dist/bin.mjs' || true; " +
    "for _ in $(seq 1 30); do pgrep -f '[m]anager/dist/bin.mjs' >/dev/null || break; sleep 1; done; exit 0",
  { timeoutMs: 120_000 },
);
await sandbox.commands.run(
  `nohup env T3CODE_ENVIRONMENT_CONTROL_CONFIG=/home/user/environment-control.json ` +
    `node /home/user/manager/dist/bin.mjs serve --mode web --host 0.0.0.0 --port ${port} ` +
    `--base-dir ${MANAGER_BASE_DIR} --no-browser >/home/user/manager.log 2>&1 </dev/null & disown`,
  { background: true },
);

let ready = false;
for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
  const probe = await sandbox.commands.run(
    `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/.well-known/t3/environment || true`,
    { timeoutMs: 30_000 },
  );
  if (probe.stdout.trim() === "200") ready = true;
  else await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!ready) {
  const log = await sandbox.commands.run("tail -20 /home/user/manager.log", { timeoutMs: 30_000 });
  throw new Error(`Manager did not become ready:\n${log.stdout}`);
}

const descriptor = {
  sandboxId: sandbox.sandboxId,
  host,
  port,
  sha256,
  revision,
  templateId,
  accounts: state.accounts,
};
await NodeFSP.writeFile(
  NodePath.join(output, "manager.json"),
  `${JSON.stringify(descriptor, null, 2)}\n`,
  { mode: 0o600 },
);
const redacted = { ...managerConfig, e2bApiKey: "[redacted]" };
await NodeFSP.writeFile(
  NodePath.join(output, "manager-config.json"),
  `${JSON.stringify(redacted, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`manager ready ${sandbox.sandboxId} https://${host}`);
