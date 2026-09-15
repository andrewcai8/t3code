#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";

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
    output: { type: "string" },
    artifact: { type: "string" },
    auth: { type: "string", default: NodePath.join(NodeOS.homedir(), ".codex/auth.json") },
    port: { type: "string", default: "3775" },
    account: { type: "string", default: "provision-manager" },
    sandbox: { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/cloud/deploy-provision-manager.mjs --output DIRECTORY [--config FILE]\n" +
      "       [--artifact FILE] [--auth FILE] [--port PORT] [--account NAME]\n\n" +
      "Stands up a provisioning manager in E2B. The manager runs the pinned runtime\n" +
      "artifact, never the template's published t3, which is upstream's build and does\n" +
      "not carry this fork's provisioning code. Builds the artifact when --artifact is\n" +
      "absent. Writes a descriptor and the manager's own config to --output.",
  );
  process.exit(0);
}
if (!values.output) throw new Error("--output DIRECTORY is required");

const repoRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const output = NodePath.resolve(values.output);
await NodeFSP.mkdir(output, { recursive: true, mode: 0o700 });

const config = JSON.parse(await NodeFSP.readFile(values.config, "utf8"));
const apiKey = config.e2bApiKey;
if (typeof apiKey !== "string" || !apiKey) throw new Error("E2B API key is missing");
const templateId = config.provisioning?.templateId;
if (!templateId) throw new Error("Configure provisioning.templateId before deploying a manager");

const run = (command, args) => {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    // COPYFILE_DISABLE is what actually suppresses AppleDouble sidecars on
    // macOS. `tar --no-xattrs` alone does not, and the sidecars are invisible
    // locally, so a bundle only looks wrong once it is inside the sandbox.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

let artifactPath = values.artifact;
if (!artifactPath) {
  artifactPath = NodePath.join(output, "runtime-linux.tar");
  console.log("building the runtime artifact");
  run("node", ["apps/server/scripts/build-runtime-artifact.ts", artifactPath]);
}
const artifact = await NodeFSP.readFile(artifactPath);
const sha256 = NodeCrypto.createHash("sha256").update(artifact).digest("hex");
const revision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot })
  .toString()
  .trim();

/** Skill bundles travel as archives, one per configured source. */
const bundles = [];
for (const [index, skill] of (config.provisioning?.skills ?? []).entries()) {
  const archive = NodePath.join(output, `skills-${index}.tgz`);
  run("tar", [
    "--no-xattrs",
    "-czf",
    archive,
    "-C",
    NodePath.dirname(skill.source),
    NodePath.basename(skill.source),
  ]);
  bundles.push({
    archive,
    index,
    source: skill.source,
    ...(skill.name ? { name: skill.name } : {}),
  });
}

// Reusing a sandbox matters on a retry: the artifact upload is the slow step,
// and a failure part way through would otherwise strand the box it created.
const sandbox = values.sandbox
  ? await Sandbox.connect(values.sandbox, { apiKey })
  : await Sandbox.create(templateId, {
      apiKey,
      timeoutMs: 3_600_000,
      lifecycle: { onTimeout: "pause" },
      metadata: { purpose: "t3-environment", account: values.account },
    });
console.log(
  values.sandbox
    ? `reusing manager sandbox ${sandbox.sandboxId}`
    : `created a manager from template ${templateId}`,
);
const port = Number(values.port);
const host = sandbox.getHost(port);

const managerConfig = {
  e2bApiKey: apiKey,
  broker: {
    sandboxId: sandbox.sandboxId,
    metadata: { purpose: "t3-environment", account: values.account },
    url: `https://${host}`,
    ingressKey: `ingress-${NodeCrypto.randomUUID()}`,
  },
  targets: [],
  provisioning: {
    templateId,
    ...(config.provisioning?.githubToken ? { githubToken: config.provisioning.githubToken } : {}),
    ...(config.provisioning?.namespace ? { namespace: config.provisioning.namespace } : {}),
    // Carry the host's provisioning policy through. Dropping egressAllow left
    // provisioned environments without the allowlist their preparation needs,
    // which fails far from here as an unreachable package host.
    ...(config.provisioning?.egressAllow ? { egressAllow: config.provisioning.egressAllow } : {}),
    // `shellEnvironment` is deliberately not carried over. Its entries name a
    // `source` path on the host's filesystem, which does not exist in the
    // sandbox, and freezing a manifest reads every one of them — so copying it
    // makes every provision fail with an ENOENT naming a path from another
    // machine. Secrets the guest needs have to be delivered to the guest.

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
    skills: bundles.map((bundle) => ({
      source: `/home/user/skills/${bundle.index}/${NodePath.basename(bundle.source)}`,
      ...(bundle.name ? { name: bundle.name } : {}),
    })),
  },
};

await sandbox.files.write("/home/user/environment-control.json", JSON.stringify(managerConfig));
await sandbox.files.write("/home/user/.codex/auth.json", await NodeFSP.readFile(values.auth));
// The runtime artifact is hundreds of megabytes; the SDK's default request
// timeout aborts the upload part way and leaves the sandbox half-built.
await sandbox.files.write("/home/user/runtime-linux.tar", artifact, {
  requestTimeoutMs: 1_800_000,
});
for (const bundle of bundles)
  await sandbox.files.write(
    `/home/user/skills-${bundle.index}.tgz`,
    await NodeFSP.readFile(bundle.archive),
  );

console.log("installing the runtime artifact");
const install = await sandbox.commands.run(
  [
    "set -eu",
    "chmod 600 /home/user/environment-control.json /home/user/.codex/auth.json",
    ...bundles.map(
      (bundle) =>
        `mkdir -p /home/user/skills/${bundle.index} && tar -xzf /home/user/skills-${bundle.index}.tgz -C /home/user/skills/${bundle.index}`,
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
    `--base-dir /home/user/manager-state --no-browser >/home/user/manager.log 2>&1 </dev/null & disown`,
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

const descriptor = { sandboxId: sandbox.sandboxId, host, port, sha256, revision, templateId };
await NodeFSP.writeFile(
  NodePath.join(output, "manager.json"),
  `${JSON.stringify(descriptor, null, 2)}\n`,
  { mode: 0o600 },
);
await NodeFSP.writeFile(
  NodePath.join(output, "manager-config.json"),
  `${JSON.stringify({ ...managerConfig, e2bApiKey: "[redacted]" }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`manager ready ${sandbox.sandboxId} https://${host}`);
