// @effect-diagnostics nodeBuiltinImport:off - a fast-path CLI that loads nothing heavy.
/**
 * `t3 fork-exec [--timeout <seconds>] [--size <name>] [--input <path>]... [--output <path>]...
 * -- <command>`: runs a command in a throwaway copy of this machine or worktree and prints its
 * output and exit code as if it ran here (see home/ForkExec.ts). An input is a file or directory
 * the copy gets at the same path; an output comes back to the same path once the command exits.
 *
 * Exit codes: the command's own, 124 when it timed out, 70 when its copy was lost, and 75 when no
 * copy could start, so a wrapper can run the command here instead. When the socket closes under a
 * running copy, as when T3 Code restarts, it rejoins the job for up to ten minutes and exits as the
 * command did; only a job it cannot rejoin is lost.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

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
/** How long a caller whose socket closed keeps trying to rejoin its job, as T3 Code restarts. */
const REJOIN_WINDOW_MS = 10 * 60_000;
const REJOIN_MAX_DELAY_MS = 10_000;
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

/** What one connection ended with: the exit code, or why it ended without one. */
interface Exchange {
  readonly code: number | null;
  readonly connected: boolean;
  readonly error?: Error;
  /** The server answered an attach with `unavailable`: it cannot rejoin jobs. */
  readonly refused?: string;
}

export async function runForkExec(
  args: ReadonlyArray<string>,
  options: { readonly rejoinWindowMs?: number } = {},
): Promise<number> {
  const parsed = parseForkExecArgs(args);
  if (parsed === null) {
    process.stderr.write(USAGE);
    return 2;
  }
  const home = process.env.T3CODE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".t3");
  const path = forkExecSocketPath(home);
  const request = {
    ...parsed,
    cwd: process.cwd(),
    environment: portableEnvironment(process.env),
  };
  let socket: NodeNet.Socket | null = null;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      socket?.destroy();
      process.exit(130);
    });
  let jobId: string | null = null;
  const seen = { stdout: 0, stderr: 0 };

  const exchange = (line: string, attaching: boolean) =>
    new Promise<Exchange>((resolve) => {
      const connection = NodeNet.createConnection(path);
      socket = connection;
      let buffered = "";
      let code: number | null = null;
      let connected = false;
      let error: Error | undefined;
      let refused: string | undefined;
      connection.on("connect", () => {
        connected = true;
        connection.write(`${line}\n`);
      });
      connection.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        for (
          let newline = buffered.indexOf("\n");
          newline !== -1;
          newline = buffered.indexOf("\n")
        ) {
          const event = decodeEvent(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          if (attaching && event.kind === "unavailable") {
            refused = event.message;
            continue;
          }
          if (event.kind === "started") jobId = event.batchId;
          if (event.kind === "output") seen[event.stream] += Buffer.byteLength(event.text, "utf8");
          const reported = report(event);
          if (reported !== -1) code = reported;
        }
      });
      connection.on("error", (cause) => (error = cause));
      connection.on("close", () =>
        resolve({
          code,
          connected,
          ...(error === undefined ? {} : { error }),
          ...(refused === undefined ? {} : { refused }),
        }),
      );
    });

  const first = await exchange(JSON.stringify(request), false);
  if (first.code !== null) return first.code;
  if (jobId === null) {
    if (first.error === undefined) return FORK_LOST_EXIT;
    process.stderr.write(`[t3] No copy of this machine could start: ${first.error.message}\n`);
    return FORK_UNAVAILABLE_EXIT;
  }

  // The copy runs on without this connection, so it is rejoined once the server answers again.
  const job: string = jobId;
  const windowMs = options.rejoinWindowMs ?? REJOIN_WINDOW_MS;
  process.stderr.write(
    `[t3] Lost the connection to T3 Code, which may be restarting; rejoining job ${job} for up to ${Math.round(windowMs / 60_000)} minutes.\n`,
  );
  let waited = 0;
  let delay = 250;
  let reason = "T3 Code did not answer in time";
  for (;;) {
    const attempt = await exchange(
      JSON.stringify({ attach: job, stdoutBytes: seen.stdout, stderrBytes: seen.stderr }),
      true,
    );
    if (attempt.code !== null) return attempt.code;
    if (attempt.refused !== undefined) {
      reason = `this T3 Code cannot rejoin jobs (${attempt.refused})`;
      break;
    }
    if (waited + delay > windowMs) break;
    await NodeTimersPromises.setTimeout(delay);
    waited += delay;
    delay = Math.min(delay * 2, REJOIN_MAX_DELAY_MS);
  }
  process.stderr.write(`[t3] Could not rejoin job ${job}: ${reason}.\n`);
  return FORK_LOST_EXIT;
}
