// @effect-diagnostics nodeBuiltinImport:off - the entrypoint and guest helper run as real local processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { guestInitScript, spawnDetachedScript } from "./guestInit.ts";
import { boundedRunScript } from "./remotePreparation.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const parentOf = (pid: number) =>
  Number(
    NodeChildProcess.execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }),
  );

/** Runs the guest helper once, as a guest script does, and returns the pid it started. */
const spawnFromGuest = (log: string, socket: string) => {
  const started = NodeChildProcess.spawnSync(
    "python3",
    [
      "-c",
      `${spawnDetachedScript}\nimport os, sys\nprint(spawn_detached(['sleep', '30'], os.environ, None, sys.argv[1]))`,
      log,
    ],
    { encoding: "utf8", env: { ...process.env, T3_INIT_SOCKET: socket } },
  );
  expect(started.stderr).toBe("");
  const pid = Number(started.stdout.trim());
  cleanups.push(() => void process.kill(pid));
  return pid;
};

const startInit = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-init-"));
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const socket = NodePath.join(directory, "init.sock");
  const init = NodeChildProcess.spawn("python3", ["-c", guestInitScript, socket], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(() => void init.kill());
  await new Promise<void>((resolve, reject) => {
    init.stdout.once("data", () => resolve());
    init.once("exit", (code) => reject(new Error(`init exited ${code}`)));
  });
  return { directory, socket, init };
};

/** Runs `run_attached` on a shell line in a guest script and returns what it printed or raised. */
const runAttached = (socket: string, line: string, timeout = 30) =>
  NodeChildProcess.spawnSync(
    "python3",
    [
      "-c",
      `import contextlib, json, os, subprocess, sys\n${boundedRunScript}\n${spawnDetachedScript}
try:
    print(json.dumps({'output': run_attached(['sh', '-c', sys.argv[1]], None, os.environ, float(sys.argv[2]))}))
except Exception as error:
    print(json.dumps({'error': type(error).__name__ + ': ' + str(error)}))`,
      line,
      String(timeout),
    ],
    { encoding: "utf8", env: { ...process.env, T3_INIT_SOCKET: socket } },
  );

describe("guest init", () => {
  it("starts a guest's long-lived process as the entrypoint's own child", async () => {
    const { directory, socket, init } = await startInit();

    const viaInit = spawnFromGuest(NodePath.join(directory, "via-init.log"), socket);
    expect(parentOf(viaInit)).toBe(init.pid);

    const detached = spawnFromGuest(
      NodePath.join(directory, "detached.log"),
      NodePath.join(directory, "absent.sock"),
    );
    expect(parentOf(detached)).not.toBe(init.pid);
    expect(process.kill(detached, 0)).toBe(true);
  });

  it("runs a prepare command under the entrypoint and returns once it exits, leaving its service running", async () => {
    const { init, socket } = await startInit();

    const parent = runAttached(socket, "ps -o ppid= -p $PPID | tr -d ' '");
    expect(JSON.parse(parent.stdout)).toEqual({ output: String(init.pid) });

    // Waiting on the service it left running would end in a timeout instead of its output.
    const service = runAttached(socket, "sleep 30 & echo $!", 5);
    const servicePid = Number(JSON.parse(service.stdout).output);
    cleanups.push(() => void process.kill(servicePid));
    expect(process.kill(servicePid, 0)).toBe(true);

    expect(JSON.parse(runAttached(socket, "echo no redis here; exit 3").stdout)).toEqual({
      error: "RuntimeError: Preparation command failed: no redis here",
    });
    expect(JSON.parse(runAttached(socket, "sleep 30", 0.5).stdout)).toEqual({
      error: "CommandTimeout: Preparation command timed out: sh -c sleep 30",
    });
  });
});
