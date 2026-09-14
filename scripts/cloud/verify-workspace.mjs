#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const { values } = NodeUtil.parseArgs({
  options: {
    cwd: { type: "string", default: process.cwd() },
    provider: { type: "string", default: "codex" },
    package: { type: "string", multiple: true, default: ["package.json"] },
    branch: { type: "string" },
    https: { type: "string", multiple: true, default: [] },
    "required-path": { type: "string", multiple: true, default: [] },
    backend: { type: "boolean", default: false },
    native: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/cloud/verify-workspace.mjs [--cwd PATH] [--provider codex|claude|cursor] [--package package.json] [--branch BRANCH] [--https URL] [--required-path PATH] [--backend] [--native]",
  );
  console.log(
    "Checks tools, package-manager pins, GitHub authentication, and verified HTTPS transport. Does not claim model execution, app launch, or backend delivery.",
  );
  process.exit(0);
}
const providers = new Map([
  ["codex", "codex"],
  ["claude", "claude"],
  ["cursor", "agent"],
]);
const provider = providers.get(values.provider);
if (!provider) throw new Error("Unsupported provider; choose codex, claude, or cursor");
const cwd = NodePath.resolve(values.cwd);
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const rows = [];
async function check(id, run) {
  const started = performance.now();
  let result;
  try {
    result = { id, status: "passed", ...(await run()) };
  } catch (error) {
    result = {
      id,
      status: "failed",
      code: typeof error.code === "string" ? error.code : "CHECK_FAILED",
    };
  }
  result.durationMs = Math.round(performance.now() - started);
  rows.push(result);
  console.log(JSON.stringify(result));
}
async function command(file, args) {
  const result = await exec(file, args, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
function requireCondition(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

await check("tls.verification-enabled", async () => {
  const disabled = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        (name === "NODE_TLS_REJECT_UNAUTHORIZED" && value === "0") ||
        (["PYTHONHTTPSVERIFY", "NPM_CONFIG_STRICT_SSL", "npm_config_strict_ssl"].includes(name) &&
          ["0", "false"].includes(value)) ||
        (name === "GIT_SSL_NO_VERIFY" && ["1", "true"].includes(value)),
    )
    .map(([name]) => name);
  requireCondition(disabled.length === 0, "TLS_VERIFICATION_DISABLED");
  return {};
});
const tools = ["node", "bun", "git", "gh", "rg", "python3", provider];
if (values.backend) tools.push("redis-server", "redis-cli");
for (const tool of new Set(tools)) {
  await check(`tool.${tool}`, async () => ({
    version: (await command(tool, ["--version"])).split("\n")[0].slice(0, 160),
  }));
}
for (const manifest of values.package) {
  await check(`package-manager.${manifest}`, async () => {
    const parsed = JSON.parse(await NodeFSP.readFile(NodePath.resolve(cwd, manifest), "utf8"));
    const match = /^(bun|pnpm|npm|yarn)@([^+]+)(?:\+.*)?$/.exec(parsed.packageManager ?? "");
    requireCondition(match, "PACKAGE_MANAGER_PIN_MISSING");
    const actual = await command(match[1], ["--version"]);
    requireCondition(actual === match[2], "PACKAGE_MANAGER_VERSION_MISMATCH");
    return { expected: match[2], actual, manager: match[1] };
  });
}
await check("git.checkout", async () => ({ commit: await command("git", ["rev-parse", "HEAD"]) }));
if (values.branch) {
  await check("git.requested-branch", async () => {
    await command("git", ["check-ref-format", "--branch", values.branch]);
    const actual = await command("git", ["branch", "--show-current"]);
    requireCondition(actual === values.branch, "BRANCH_MISMATCH");
    const remote = await command("git", [
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${values.branch}`,
    ]);
    const head = await command("git", ["rev-parse", "HEAD"]);
    requireCondition(remote.split(/\s/)[0] === head, "REMOTE_COMMIT_MISMATCH");
    return { branch: actual, commit: head };
  });
}
await check("github.authenticated-api", async () => {
  await command("gh", ["api", "user", "--silent"]);
  return {};
});
for (const required of values["required-path"]) {
  await check(`path.${required}`, async () => {
    await NodeFSP.access(NodePath.resolve(cwd, required));
    return {};
  });
}
for (const endpoint of values.https) {
  const url = new URL(endpoint);
  requireCondition(
    url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash,
    "EXPECTED_CREDENTIAL_FREE_HTTPS_URL",
  );
  await check(
    `https-transport.${url.hostname}`,
    () =>
      new Promise((resolve, reject) => {
        const request = NodeHttps.get(url, { rejectUnauthorized: true }, (response) => {
          const authorized = response.socket.authorized;
          response.resume();
          if (!authorized)
            reject(Object.assign(new Error("TLS not authorized"), { code: "TLS_UNAUTHORIZED" }));
          else resolve({ httpStatus: response.statusCode, certificateVerified: true });
        });
        request.setTimeout(15000, () =>
          request.destroy(Object.assign(new Error("HTTPS timeout"), { code: "HTTPS_TIMEOUT" })),
        );
        request.on("error", reject);
      }),
  );
}
if (values.native) {
  await check("native.platform", async () => {
    requireCondition(
      (await command("uname", ["-sm"])) === "Darwin arm64",
      "EXPECTED_APPLE_SILICON_MAC",
    );
    return {};
  });
  await check("native.xcode", async () => ({ version: await command("xcodebuild", ["-version"]) }));
  await check("native.simulator-runtime", async () => {
    const result = JSON.parse(await command("xcrun", ["simctl", "list", "runtimes", "--json"]));
    const available = result.runtimes.filter(
      (runtime) => runtime.isAvailable && runtime.identifier.includes(".iOS-"),
    );
    requireCondition(available.length > 0, "IOS_RUNTIME_MISSING");
    return { runtimes: available.map((runtime) => runtime.identifier) };
  });
}
const failed = rows.filter((row) => row.status === "failed").map((row) => row.id);
console.log(
  JSON.stringify({
    kind: "summary",
    checked: rows.length,
    failed,
    scope: "prerequisites-and-transport",
  }),
);
process.exitCode = failed.length === 0 ? 0 : 1;
