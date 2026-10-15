// @effect-diagnostics nodeBuiltinImport:off - shared with a fast-path CLI.
/**
 * What `t3 fork-exec` and the fork-exec socket say to each other (see ForkExec.ts). Kept free of
 * server imports so the CLI stays quick to start.
 *
 * @module forkExecProtocol
 */
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

export const ForkExecRequest = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20000)),
  cwd: Schema.String.check(Schema.isMinLength(1)),
  timeoutSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86_400 })),
  ),
});
export type ForkExecRequest = typeof ForkExecRequest.Type;

/** What the socket answers, one JSON line each: `started` first, then exactly one outcome. */
export const ForkExecEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("started"), batchId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("exited"),
    exitCode: Schema.Int,
    timedOut: Schema.Boolean,
    durationMs: Schema.Number,
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
