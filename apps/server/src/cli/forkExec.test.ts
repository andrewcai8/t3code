// @effect-diagnostics nodeBuiltinImport:off - bash replays what the copy's shell would run, and a real socket plays the server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { exportsOf } from "../home/forkExecProtocol.ts";
import { parseForkExecArgs, runForkExec } from "./forkExec.ts";

const inBash = (script: string) =>
  NodeChildProcess.execFileSync("/bin/bash", ["-c", script], { env: {} }).toString();

afterEach(() => {
  vi.restoreAllMocks();
});

it("hands the copy's shell a command and its arguments exactly as given", () => {
  const parsed = parseForkExecArgs([
    "--timeout",
    "600",
    "--",
    "printf",
    "%s|",
    "it's",
    "a b",
    "$HOME",
  ]);
  expect(parsed?.timeoutSeconds).toBe(600);
  expect(inBash(parsed!.command)).toBe("it's|a b|$HOME|");
  expect(parseForkExecArgs(["--", "echo one && echo two"])?.command).toBe("echo one && echo two");
  expect(parseForkExecArgs(["--"])).toBeNull();
});

it("takes a size and a timeout in either order before the command", () => {
  expect(parseForkExecArgs(["--size", "large", "--timeout", "60", "--", "bun", "test"])).toEqual({
    command: "bun test",
    timeoutSeconds: 60,
    size: "large",
  });
  expect(parseForkExecArgs(["--timeout", "60", "--size", "xlarge", "make"])).toEqual({
    command: "make",
    timeoutSeconds: 60,
    size: "xlarge",
  });
  expect(parseForkExecArgs(["--size", "", "--", "make"])).toBeNull();
});

it("takes repeated inputs and outputs as absolute paths from the caller's directory", () => {
  expect(
    parseForkExecArgs(
      ["--input", "/data/a.json", "--output", "out", "--input", "../b", "--", "make"],
      "/repo/app",
    ),
  ).toEqual({ command: "make", inputs: ["/data/a.json", "/repo/b"], outputs: ["/repo/app/out"] });
  expect(parseForkExecArgs(["--input", "", "--", "make"])).toBeNull();
});

it("recreates the caller's environment in the copy's shell", () => {
  const exports = exportsOf({
    FLAG: `a 'b' "c" $d`,
    EMPTY: "",
    PWD: "/elsewhere",
    "BAD-NAME": "x",
  });
  expect(inBash(`${exports}printf '%s|%s|%s' "$FLAG" "\${EMPTY-unset}" "\${BAD_NAME-unset}"`)).toBe(
    `a 'b' "c" $d||unset`,
  );
  expect(exports).not.toContain("PWD");
});

it("sends its environment and size, prints live output as it comes, and exits with the command's code", async () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fx-cli-"));
  const requests: Array<unknown> = [];
  const server = NodeNet.createServer((socket) => {
    socket.once("data", (chunk) => {
      requests.push(JSON.parse(chunk.toString("utf8").trim()));
      for (const event of [
        { kind: "started", batchId: "job-1", live: true },
        { kind: "output", stream: "stdout", text: "pass 1\n" },
        { kind: "output", stream: "stderr", text: "warn\n" },
        { kind: "output", stream: "stdout", text: "pass 2\n" },
        {
          kind: "exited",
          exitCode: 3,
          timedOut: false,
          durationMs: 10,
          stdoutTail: "",
          stderrTail: "",
        },
      ])
        socket.write(`${JSON.stringify(event)}\n`);
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(NodePath.join(home, "fork.sock"), resolve));
  const written: Array<[string, string]> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    written.push(["stdout", String(chunk)]);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(["stderr", String(chunk)]);
    return true;
  });
  vi.stubEnv("T3CODE_HOME", home);
  vi.stubEnv("FORK_EXEC_PROBE", "yes");
  try {
    const code = await runForkExec(["--size", "large", "--", "bun", "test"]);
    expect(code).toBe(3);
  } finally {
    vi.unstubAllEnvs();
    server.close();
  }
  expect(requests).toEqual([
    expect.objectContaining({
      command: "bun test",
      size: "large",
      cwd: process.cwd(),
      environment: expect.objectContaining({ FORK_EXEC_PROBE: "yes" }),
    }),
  ]);
  expect(written.filter(([, text]) => text !== "")).toEqual([
    [
      "stderr",
      "[t3] Running in a throwaway copy of this worktree on Modal (job job-1); its output follows as it runs.\n",
    ],
    ["stdout", "pass 1\n"],
    ["stderr", "warn\n"],
    ["stdout", "pass 2\n"],
  ]);
});

/** Captures what the CLI writes, and serves `handle` on a fork socket in a fresh T3 home. */
const cliHarness = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fx-cli-"));
  const path = NodePath.join(home, "fork.sock");
  const requests: Array<Record<string, unknown>> = [];
  const servers: Array<NodeNet.Server> = [];
  const listen = (handle: (socket: NodeNet.Socket, request: Record<string, unknown>) => void) => {
    const server = NodeNet.createServer((socket) =>
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8").trim());
        requests.push(request);
        handle(socket, request);
      }),
    );
    servers.push(server);
    NodeFS.rmSync(path, { force: true });
    return new Promise<NodeNet.Server>((resolve) => server.listen(path, () => resolve(server)));
  };
  const send = (socket: NodeNet.Socket, events: ReadonlyArray<object>) => {
    for (const event of events) socket.write(`${JSON.stringify(event)}\n`);
  };
  const stderr: Array<string> = [];
  const stdout: Array<string> = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.stubEnv("T3CODE_HOME", home);
  const close = () => {
    vi.unstubAllEnvs();
    for (const server of servers) server.close();
  };
  return { requests, listen, send, stdout, stderr, close };
};

const started = { kind: "started", batchId: "job-1", live: true };
const exited = (exitCode: number) => ({
  kind: "exited",
  exitCode,
  timedOut: false,
  durationMs: 10,
  stdoutTail: "",
  stderrTail: "",
});

it("rejoins its job when the server restarts under it, and exits with the command's code", async () => {
  const cli = cliHarness();
  try {
    const first = await cli.listen((socket) => {
      cli.send(socket, [started, { kind: "output", stream: "stdout", text: "pass ✓\n" }]);
      // The server goes away mid-command, and a new one takes its socket.
      first.close();
      socket.destroy();
      void cli.listen((rejoined) => {
        cli.send(rejoined, [{ kind: "output", stream: "stdout", text: "pass 2\n" }, exited(3)]);
        rejoined.end();
      });
    });
    expect(await runForkExec(["--", "bun", "test"], { rejoinWindowMs: 10_000 })).toBe(3);
  } finally {
    cli.close();
  }
  expect(cli.requests[1]).toEqual({ attach: "job-1", stdoutBytes: 9, stderrBytes: 0 });
  expect(cli.stdout.join("")).toBe("pass ✓\npass 2\n");
  expect(cli.stderr.join("")).toContain("rejoining job job-1");
});

it("exits 70 when its job cannot be rejoined: an older server, or none in time", async () => {
  for (const comesBack of [true, false]) {
    const cli = cliHarness();
    try {
      const first = await cli.listen((socket) => {
        cli.send(socket, [started]);
        first.close();
        socket.destroy();
        // A server from before rejoining reads the attach as a malformed request.
        if (comesBack)
          void cli.listen((again) => {
            cli.send(again, [{ kind: "unavailable", message: "The request was malformed." }]);
            again.end();
          });
      });
      expect(await runForkExec(["--", "make"], { rejoinWindowMs: 1_000 })).toBe(70);
    } finally {
      cli.close();
    }
    expect(cli.stderr.at(-1)).toBe(
      comesBack
        ? "[t3] Could not rejoin job job-1: this T3 Code cannot rejoin jobs (The request was malformed.).\n"
        : "[t3] Could not rejoin job job-1: T3 Code did not answer in time.\n",
    );
    vi.restoreAllMocks();
  }
});
