// @effect-diagnostics nodeBuiltinImport:off - the test runs the guest Python on a real directory tree.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import { agentEnvironmentPython } from "./guestAgentEnvironment.ts";

/** Lays out a provision root as a box whose server saved its settings, then reads it as a guest. */
async function readAgentEnvironment(secrets: Record<string, string>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-agent-env-"));
  try {
    const userdata = NodePath.join(root, "home", ".t3", "userdata");
    await NodeFSP.mkdir(NodePath.join(userdata, "secrets"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(userdata, "settings.json"),
      JSON.stringify({
        providerInstances: {
          claudeAgent: {
            environment: [
              { name: "AWS_REGION", value: "", sensitive: true, valueRedacted: true },
              { name: "AWS_ACCESS_KEY_ID", value: "", sensitive: true, valueRedacted: true },
              { name: "EVAL_SUITE", value: "smoke", sensitive: false },
            ],
          },
        },
      }),
    );
    for (const [file, value] of Object.entries(secrets))
      await NodeFSP.writeFile(NodePath.join(userdata, "secrets", file), value);
    const script = `import json, os, pathlib\n${agentEnvironmentPython}\nenv, server, home, settings = agent_env(pathlib.Path(${JSON.stringify(root)}))\nprint(json.dumps({'region': env.get('AWS_REGION'), 'key': env.get('AWS_ACCESS_KEY_ID'), 'suite': env.get('EVAL_SUITE'), 'home': env.get('HOME') == ${JSON.stringify(NodePath.join(root, "home"))}, 'server': server, 'unresolved': unresolved_env(home, settings)}))`;
    return JSON.parse(
      NodeChildProcess.execFileSync("python3", ["-c", script], { encoding: "utf8" }),
    ) as unknown;
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

it("reads redacted provider values from the box's secret store, as its server does", async () => {
  // provider-env-<base64url("claudeAgent")>-<base64url(name)>.bin, as serverSettings.ts names them.
  expect(
    await readAgentEnvironment({
      "provider-env-Y2xhdWRlQWdlbnQ-QVdTX1JFR0lPTg.bin": "us-east-1",
      "provider-env-Y2xhdWRlQWdlbnQ-QVdTX0FDQ0VTU19LRVlfSUQ.bin": "AKIA-LIVE",
    }),
  ).toEqual({
    region: "us-east-1",
    key: "AKIA-LIVE",
    suite: "smoke",
    home: true,
    server: null,
    unresolved: [],
  });
});

it("leaves out a redacted value its secret store lacks, and names it", async () => {
  expect(
    await readAgentEnvironment({ "provider-env-Y2xhdWRlQWdlbnQ-QVdTX1JFR0lPTg.bin": "us-east-1" }),
  ).toEqual({
    region: "us-east-1",
    key: null,
    suite: "smoke",
    home: true,
    server: null,
    unresolved: ["AWS_ACCESS_KEY_ID"],
  });
});
