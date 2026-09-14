#!/usr/bin/env node
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { Template } = require("e2b");
const { values } = NodeUtil.parseArgs({
  options: {
    name: { type: "string", default: "t3-common-tools-node24-bun140-v1" },
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
    "Usage: node scripts/cloud/build-e2b-common-template.mjs --output DIRECTORY [--name NAME] [--config FILE] [--print-dockerfile]",
  );
  console.log(
    "Builds a clean private E2B template with 4 CPUs and 8 GiB RAM. Copies only the public installer recipe. Does not change environment-control configuration.",
  );
  process.exit(0);
}

const template = Template({
  fileContextPath: NodeURL.fileURLToPath(new URL("./", import.meta.url)),
})
  .fromImage("ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254")
  .setUser("root")
  .copy("e2b-common-tools.sh", "/opt/t3-common-tools.sh", { mode: 0o755 })
  .runCmd("bash /opt/t3-common-tools.sh system")
  .runCmd("bash /opt/t3-common-tools.sh runtimes")
  .setEnvs({
    HOME: "/home/user",
    NPM_CONFIG_PREFIX: "/home/user/.local",
    BUN_INSTALL: "/home/user/.bun",
    SWIFTLY_HOME_DIR: "/home/user/.local/share/swiftly",
    SWIFTLY_BIN_DIR: "/home/user/.local/bin",
    PATH: "/home/user/.local/bin:/home/user/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  })
  .setUser("user")
  .setWorkdir("/home/user")
  .runCmd("bash /opt/t3-common-tools.sh tools")
  .runCmd("bash /opt/t3-common-tools.sh swift")
  .runCmd(String.raw`cat > /home/user/.profile.d-common-tools.sh <<'PROFILE'
export NPM_CONFIG_PREFIX="$HOME/.local"
export NODE_OPTIONS=--max-old-space-size=4096
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
PROFILE
printf '%s\n' '. "$HOME/.profile.d-common-tools.sh"' >> /home/user/.profile
printf '%s\n' '. "$HOME/.profile.d-common-tools.sh"' >> /home/user/.bashrc`)
  .runCmd(String.raw`set -eu
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl -fsSL --retry 3 https://go.dev/dl/go1.26.4.linux-amd64.tar.gz -o "$temporary/go.tar.gz"
printf '%s  %s\n' 1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f "$temporary/go.tar.gz" | sha256sum --check --status
sudo tar -xzf "$temporary/go.tar.gz" -C /usr/local
sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt
sudo systemctl disable redis-server.service
test "$(go version)" = 'go version go1.26.4 linux/amd64'`)
  .runCmd("bash /opt/t3-common-tools.sh verify && ruby --version");

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
    cpuCount: 4,
    memoryMB: 8192,
    minFreeDiskMb: 8192,
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
    cpuCount: 4,
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
