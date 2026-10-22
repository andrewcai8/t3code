// @effect-diagnostics nodeBuiltinImport:off - shared with a fast-path CLI.
/**
 * What `t3 fork-exec` and the fork-exec socket say to each other (see ForkExec.ts). Kept free of
 * server imports so the CLI stays quick to start.
 *
 * @module forkExecProtocol
 */
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

/** Absolute and normalized, so a copy and this host read each one as the same place. */
const HostPaths = Schema.Array(
  Schema.String.check(
    Schema.makeFilter(
      (path) => path.startsWith("/") && path !== "/" && NodePath.normalize(path) === path,
    ),
  ),
).check(Schema.isMaxLength(256));

export const ForkExecRequest = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20000)),
  cwd: Schema.String.check(Schema.isMinLength(1)),
  /** The caller's environment. Each backend decides how it reaches the copy. */
  environment: Schema.Record(Schema.String, Schema.String),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  ),
  /** A size this host names; copies of a cloud machine always have the machine's own size. */
  size: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
  /**
   * Host files or directories outside what a copy of the worktree holds, which the copy gets at
   * the same paths before the command runs. A copy of a cloud machine has them already.
   */
  inputs: Schema.optional(HostPaths),
  /** Host paths the copy brings back to the same place once the command exits. */
  outputs: Schema.optional(HostPaths),
});
export type ForkExecRequest = typeof ForkExecRequest.Type;

/** A request line carries the caller's whole environment, so it may be long, but not unbounded. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * What the socket answers, one JSON line each: `started`, then (when it is `live`) the command's
 * output as it runs, then exactly one outcome.
 */
export const ForkExecEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("started"),
    batchId: Schema.String,
    live: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("exited"),
    exitCode: Schema.Int,
    timedOut: Schema.Boolean,
    durationMs: Schema.Number,
    /** Output not already sent as `output` events: empty after a live start. */
    stdoutTail: Schema.String,
    stderrTail: Schema.String,
    /** Holds the job's full stdout.log and stderr.log. */
    logsUri: Schema.optional(Schema.String),
  }),
  /** No copy started, so the caller may run the command here instead. */
  Schema.Struct({ kind: Schema.Literal("unavailable"), message: Schema.String }),
  /** A copy started and was lost, so the command may have run partly. */
  Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
]);
export type ForkExecEvent = typeof ForkExecEvent.Type;

export const forkExecSocketPath = (baseDir: string) => NodePath.join(baseDir, "fork.sock");

export const shellQuote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/** The shell's own variables are left to the copy's shell. */
const SHELL_OWNED = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

/** The variables of `environment` a shell can take, without the shell's own. */
export const portableEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).flatMap(([name, value]) =>
      value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || SHELL_OWNED.has(name)
        ? []
        : [[name, value]],
    ),
  );

/** `export` lines that recreate `environment` in a shell. */
export const exportsOf = (environment: Readonly<Record<string, string | undefined>>) =>
  Object.entries(portableEnvironment(environment))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");
