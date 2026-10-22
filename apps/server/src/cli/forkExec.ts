// @effect-diagnostics nodeBuiltinImport:off - a fast-path CLI that loads nothing heavy.
/**
 * `t3 fork-exec [--timeout <seconds>] [--size <name>] [--input <path>]... [--output <path>]...
 * -- <command>`: runs a command in a throwaway copy of this machine or worktree and prints its
 * output and exit code as if it ran here (see home/ForkExec.ts). An input is a file or directory
 * the copy gets at the same path; an output comes back to the same path once the command exits.
 *
 * Exit codes: the command's own, 124 when it timed out, 70 when its copy was lost, and 75 when no
 * copy could start, so a wrapper can run the command here instead.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import {
  type ForkExecEvent,
  ForkExecEvent as ForkExecEventSchema,
  forkExecSocketPath,
  portableEnvironment,
  shellQuote,
} from "../home/forkExecProtocol.ts";

const FORK_UNAVAILABLE_EXIT = 75;
const FORK_LOST_EXIT = 70;
const TIMED_OUT_EXIT = 124;
/** A copy reports the last 4,000 bytes of each stream. */
const TAIL_CHARS = 3_900;

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ForkExecEventSchema));

const USAGE =
  "Usage: t3 fork-exec [--timeout <seconds>] [--size <name>] [--input <path>]... [--output <path>]... -- <command>\n";

/**
 * Flags come in any order before `--`; `--input` and `--output` repeat, and their paths resolve
 * against `cwd`. One argument after the flags is a shell command as given; several are a command
 * and its arguments.
 */
export function parseForkExecArgs(args: ReadonlyArray<string>, cwd = process.cwd()) {
  let rest = [...args];
  let timeoutSeconds: number | undefined;
  let size: string | undefined;
  const inputs: Array<string> = [];
  const outputs: Array<string> = [];
  for (;;) {
    if (rest[0] === "--timeout") timeoutSeconds = Number(rest[1]);
    else if (rest[0] === "--size") size = rest[1];
    else if (rest[0] === "--input" || rest[0] === "--output") {
      if (!rest[1]) return null;
      (rest[0] === "--input" ? inputs : outputs).push(NodePath.resolve(cwd, rest[1]));
    } else break;
    rest = rest.slice(2);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  if (
    rest.length === 0 ||
    (timeoutSeconds !== undefined && !Number.isInteger(timeoutSeconds)) ||
    size === ""
  )
    return null;
  return {
    command: rest.length === 1 ? rest[0]! : rest.map(shellQuote).join(" "),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(size === undefined ? {} : { size }),
    ...(inputs.length === 0 ? {} : { inputs }),
    ...(outputs.length === 0 ? {} : { outputs }),
  };
}

/** The job's full log from S3, or null when this machine cannot read it. */
const fullLog = (logsUri: string, name: string): Buffer | null => {
  const read = NodeChildProcess.spawnSync("aws", ["s3", "cp", `${logsUri}${name}`, "-"], {
    maxBuffer: 512 * 1024 ** 2,
  });
  return read.status === 0 ? read.stdout : null;
};

const report = (event: ForkExecEvent): number => {
  switch (event.kind) {
    case "started":
      process.stderr.write(
        event.live
          ? `[t3] Running in a throwaway copy of this worktree on Modal (job ${event.batchId}); its output follows as it runs.\n`
          : `[t3] Running in a throwaway copy of this machine (batch ${event.batchId}); its output follows when it finishes.\n`,
      );
      return -1;
    case "output":
      (event.stream === "stdout" ? process.stdout : process.stderr).write(event.text);
      return -1;
    case "exited": {
      const stdout = event.logsUri ? fullLog(event.logsUri, "stdout.log") : null;
      const stderr = event.logsUri ? fullLog(event.logsUri, "stderr.log") : null;
      const cut = (full: Buffer | null, tail: string) => full === null && tail.length >= TAIL_CHARS;
      if (cut(stdout, event.stdoutTail) || cut(stderr, event.stderrTail))
        process.stderr.write(
          "[t3] The full logs were not readable, so a stream below shows only its last 4 KB.\n",
        );
      process.stdout.write(stdout ?? event.stdoutTail);
      process.stderr.write(stderr ?? event.stderrTail);
      if (event.timedOut) process.stderr.write("[t3] The command timed out in its copy.\n");
      return event.timedOut ? TIMED_OUT_EXIT : event.exitCode;
    }
    case "unavailable":
      process.stderr.write(`[t3] No copy of this machine could start: ${event.message}\n`);
      return FORK_UNAVAILABLE_EXIT;
    case "failed":
      process.stderr.write(`[t3] The copy running the command was lost: ${event.message}\n`);
      return FORK_LOST_EXIT;
  }
};

export async function runForkExec(args: ReadonlyArray<string>): Promise<number> {
  const parsed = parseForkExecArgs(args);
  if (parsed === null) {
    process.stderr.write(USAGE);
    return 2;
  }
  const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  const request = {
    ...parsed,
    cwd: process.cwd(),
    environment: portableEnvironment(process.env),
  };
  const socket = NodeNet.createConnection(forkExecSocketPath(home));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      socket.destroy();
      process.exit(130);
    });
  return new Promise<number>((resolve) => {
    let buffered = "";
    let exitCode: number | null = null;
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const code = report(decodeEvent(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
        if (code !== -1) exitCode = code;
      }
    });
    socket.on("error", (error) => {
      process.stderr.write(`[t3] No copy of this machine could start: ${error.message}\n`);
      exitCode ??= FORK_UNAVAILABLE_EXIT;
    });
    socket.on("close", () => resolve(exitCode ?? FORK_LOST_EXIT));
  });
}
