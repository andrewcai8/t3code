// @effect-diagnostics nodeBuiltinImport:off - the test runs a copy's job script on a real directory tree.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";

import { captureBatch, forkRunScript } from "./ForkMachines.ts";

it("reads the batch from a capture's snapshot name, with or without its team and tag", () => {
  const batch = "7880e39f-43ec-496e-b333-f616a22862bf";
  expect(
    [
      `acme/t3-worker-fork-host-a-${batch}:default`,
      `acme/t3-worker-fork-host-a-${batch}`,
      `t3-worker-fork-host-a-${batch}:v2`,
      `acme/t3-worker-fork-host-b-${batch}:default`,
      "acme/t3-natural-recovery-20260913-2022:default",
    ].map((name) => captureBatch("Host A", name)),
  ).toEqual([batch, batch, batch, null, null]);
});

/** Runs a job as a quieted copy does, in a checkout `checkout` and a job directory `work`. */
async function runInCopy(
  job: (dirs: { checkout: string; work: string }) => {
    readonly command: string;
    readonly services: ReadonlyArray<string>;
  },
) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-run-")),
  );
  const state = NodePath.join(root, "state");
  const checkout = NodePath.join(root, "checkout");
  const work = NodePath.join(root, "work");
  for (const dir of [NodePath.join(state, "out"), checkout, work])
    await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(state, "env.json"),
    JSON.stringify({ PATH: process.env.PATH, HOME: root }),
  );
  const { command, services } = job({ checkout, work });
  const exit = JSON.parse(
    NodeChildProcess.execFileSync(
      "python3",
      [
        "-c",
        forkRunScript(state),
        JSON.stringify({
          command,
          cwd: work,
          timeoutMs: 60_000,
          services: { commands: services, cwd: checkout },
        }),
      ],
      { encoding: "utf8" },
    ),
  ) as unknown;
  return { exit, root, checkout, work };
}

it("starts the repository's services in the checkout, then runs the job beside them", async () => {
  const { exit, root, checkout } = await runInCopy(({ checkout }) => ({
    services: ["sleep 300 > /dev/null 2>&1 & echo $! > service.pid"],
    command: `kill -0 "$(cat ${checkout}/service.pid)" && echo service is up`,
  }));
  try {
    expect(exit).toEqual({
      exitCode: 0,
      timedOut: false,
      stdoutTail: "service is up\n",
      stderrTail:
        "[t3] Starting this machine's services: sleep 300 > /dev/null 2>&1 & echo $! > service.pid\n",
    });
  } finally {
    process.kill(Number(await NodeFSP.readFile(NodePath.join(checkout, "service.pid"), "utf8")));
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("answers a failed service command as the job's result, without running the job", async () => {
  const { exit, root, work } = await runInCopy(() => ({
    services: ["echo first >&2", "echo no redis >&2; exit 3", "touch ../work/later"],
    command: "touch ran",
  }));
  try {
    expect([exit, await NodeFSP.readdir(work)]).toEqual([
      {
        exitCode: 3,
        timedOut: false,
        stdoutTail: "",
        stderrTail: [
          "[t3] Starting this machine's services: echo first >&2",
          "first",
          "[t3] Starting this machine's services: echo no redis >&2; exit 3",
          "no redis",
          "[t3] It exited 3, so the job did not run.",
          "",
        ].join("\n"),
      },
      [],
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
