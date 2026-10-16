#!/usr/bin/env node
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { COMMON_TOOLS_BASE, COMMON_TOOLS_STEPS } from "./common-tools-image.mjs";

const require = NodeModule.createRequire(
  new URL("../../apps/server/package.json", import.meta.url),
);
const { ModalClient } = require("modal");
const { values } = NodeUtil.parseArgs({
  options: {
    app: { type: "string", default: "t3-cloud-chats" },
    environment: { type: "string" },
    config: {
      type: "string",
      default: NodePath.join(NodeOS.homedir(), ".t3/environment-control.json"),
    },
    "print-commands": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node scripts/cloud/build-modal-image.mjs [--app NAME] [--environment ENV] [--config FILE] [--print-commands]",
  );
  console.log(
    "Builds the Linux cloud box image the E2B template is built from, in the Modal app NAME (default t3-cloud-chats) of environment ENV (default the workspace default), and prints its image id for provisioning.modal.imageId. Credentials come from MODAL_TOKEN_ID/MODAL_TOKEN_SECRET, else modalTokenId/modalTokenSecret in FILE. Does not change configuration.",
  );
  process.exit(0);
}

const encoded = (text) => Buffer.from(text).toString("base64");
const context = new URL("./", import.meta.url);
// Modal builds every step as root and ignores USER, and its builder sets no_new_privs, so sudo
// works only for root. A step meant for the box's user runs as root under that user's name, and
// the home those steps filled is handed to the user at the end. A multi-line script travels
// encoded because a Dockerfile command is one line.
let user = "root";
const homes = new Set();
const commands = [];
for (const step of COMMON_TOOLS_STEPS) {
  if ("user" in step) user = step.user;
  else if ("env" in step)
    commands.push(
      `ENV ${Object.entries(step.env)
        .map(([name, value]) => `${name}=${value}`)
        .join(" ")}`,
    );
  else if ("workdir" in step) commands.push(`WORKDIR ${step.workdir}`);
  else if ("copy" in step) {
    const contents = NodeFS.readFileSync(new URL(step.copy, context), "utf8");
    commands.push(
      `RUN mkdir -p ${NodePath.posix.dirname(step.to)} && echo ${encoded(contents)} | base64 -d > ${step.to} && chmod ${step.mode.toString(8)} ${step.to}`,
    );
  } else {
    if (user !== "root") homes.add(user);
    commands.push(
      `RUN ${user === "root" ? "" : `env USER=${user} LOGNAME=${user} `}bash -c "$(echo ${encoded(step.run)} | base64 -d)"`,
    );
  }
}
for (const owner of homes) commands.push(`RUN chown -R ${owner}:${owner} /home/${owner}`);

if (values["print-commands"]) {
  console.log([`FROM ${COMMON_TOOLS_BASE}`, ...commands].join("\n"));
  process.exit(0);
}
const configured = () => {
  const config = JSON.parse(NodeFS.readFileSync(values.config, "utf8"));
  if (!config.modalTokenId || !config.modalTokenSecret)
    throw new Error("Modal credentials are missing");
  return { tokenId: config.modalTokenId, tokenSecret: config.modalTokenSecret };
};
const modal = new ModalClient(
  process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET ? {} : configured(),
);
const app = await modal.apps.fromName(values.app, {
  createIfMissing: true,
  ...(values.environment ? { environment: values.environment } : {}),
});
const started = performance.now();
// One layer per step, each built before the next, so a failure names its step and a rerun
// starts from the last layer that built.
let image = modal.images.fromRegistry(COMMON_TOOLS_BASE);
for (const [index, command] of commands.entries()) {
  image = await image.dockerfileCommands([command]).build(app);
  console.error(
    `step ${index + 1}/${commands.length} built ${image.imageId}: ${command.slice(0, 80)}`,
  );
}
console.log(
  JSON.stringify({
    app: values.app,
    imageId: image.imageId,
    durationMs: Math.round(performance.now() - started),
  }),
);
