// @effect-diagnostics nodeBuiltinImport:off - Effect has no Unix socket server.
/**
 * ForkExec - runs one shell command in a throwaway copy of this machine or worktree, for any
 * process on it.
 *
 * Whole-repo checks (typechecks, full test suites, builds) push a machine into swap, which stalls
 * every agent on it. `t3 fork-exec -- <command>` hands the command to this service over a Unix
 * socket in T3 home, which only processes on this machine can open. On a cloud box it runs the
 * command as a one-job t3_fork_run batch for the machine's own chat, the one actor its host accepts
 * for forks, waits for it, and answers with the job's exit code and output. On a self-hosted
 * server with worktree forks (WorktreeForks.ts) it runs it in a Modal copy of the caller's
 * worktree, with the output live. Subagents, scripts and every provider reach it the same way, so
 * nothing has to be taught to use it.
 *
 * @module ForkExec
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  CLOUD_FORKS_ENVIRONMENT_ID,
  type FleetForkBatch,
  type FleetRequest,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { reconcileBunShim } from "./bunShim.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as WorktreeForks from "./WorktreeForks.ts";
import {
  exportsOf,
  ForkExecAttach,
  ForkExecEvent,
  ForkExecRequest,
  forkExecSocketPath,
  MAX_REQUEST_BYTES,
  shellQuote,
} from "./forkExecProtocol.ts";

const unavailable = (message: string) =>
  new OrchestratorMcpFailure({ code: "environment_unavailable", message });

/**
 * Runs `request` as a one-job batch for this machine's own chat, which its host names in the
 * forks environment it offers. `emit` gets `started` once the batch exists.
 */
const runInFork = Effect.fn("ForkExec.runInFork")(
  function* (request: ForkExecRequest, emit: (event: ForkExecEvent) => Effect.Effect<void>) {
    const broker = yield* FleetBroker.FleetBroker;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    yield* FleetBroker.awaitHostReconnect;
    const { hostConnected, environments } = yield* broker.reach;
    const owner = environments.find(
      (environment) => environment.environmentId === CLOUD_FORKS_ENVIRONMENT_ID,
    )?.chat?.threadId;
    // A copy of this machine starts with its inputs on disk, but nothing brings its files back.
    if ((request.outputs ?? []).length > 0)
      return yield* unavailable("A copy of this machine cannot bring outputs back.");
    if (!hostConnected) return yield* unavailable("This machine's host is not connected.");
    if (owner === undefined)
      return yield* unavailable("This machine's host does not offer forks to its own chat.");
    const invoke = Effect.fn("ForkExec.invoke")(
      function* (fleetRequest: FleetRequest) {
        yield* FleetBroker.awaitHostReconnect;
        return yield* broker.invoke(CLOUD_FORKS_ENVIRONMENT_ID, {
          actor: { environmentId, threadId: owner },
          request: fleetRequest,
        });
      },
      Effect.retry({ while: FleetBroker.isRelayLoss, times: 2 }),
    );

    // The copy starts from this machine's disk, so the command picks up its caller's environment
    // from a file written before the copy is taken.
    const environmentFile = NodePath.join(
      (yield* ServerConfig).baseDir,
      "fork-exec",
      `${NodeCrypto.randomUUID()}.env`,
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(environmentFile, { force: true })),
    );
    yield* Effect.try(() => {
      NodeFS.mkdirSync(NodePath.dirname(environmentFile), { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(environmentFile, exportsOf(request.environment), { mode: 0o600 });
    }).pipe(Effect.mapError(() => unavailable("The caller's environment could not be saved.")));
    const { cwd, timeoutSeconds } = request;
    const command = `. ${shellQuote(environmentFile)} && ${request.command}`;
    const job = { command, cwd, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) };
    const { batchId } = (yield* invoke({
      op: "forks.run",
      input: { jobs: [job] },
    })) as FleetForkBatch;
    yield* emit({ kind: "started", batchId });

    const waitForFinish = Effect.gen(function* () {
      for (;;) {
        const batch = (yield* invoke({
          op: "forks.status",
          input: { batchId, waitSeconds: 45 },
        })) as FleetForkBatch;
        if (batch.state === "finished") return batch.jobs[0];
      }
    }).pipe(
      Effect.onInterrupt(() =>
        invoke({ op: "forks.cancel", input: { batchId } }).pipe(Effect.ignore),
      ),
    );
    const outcome = yield* waitForFinish.pipe(
      Effect.map((state): ForkExecEvent =>
        state?.state === "exited"
          ? {
              kind: "exited",
              exitCode: state.exitCode,
              timedOut: state.timedOut,
              durationMs: state.durationMs,
              stdoutTail: state.stdoutTail,
              stderrTail: state.stderrTail,
              ...(state.logsUri === undefined ? {} : { logsUri: state.logsUri }),
            }
          : {
              kind: "failed",
              message: state?.state === "failed" ? state.message : `The job ended ${state?.state}.`,
            },
      ),
      Effect.catch((error) =>
        Effect.succeed<ForkExecEvent>({ kind: "failed", message: error.message }),
      ),
    );
    yield* emit(outcome);
  },
  (effect, request, emit) =>
    effect.pipe(
      Effect.catch((error) => emit({ kind: "unavailable", message: error.message })),
      Effect.scoped,
    ),
);

/**
 * Puts `t3` on this box's PATH as this server's own build, ahead of any older `t3` the machine
 * image installed, so `t3 fork-exec` always speaks this server's protocol.
 */
const linkT3Command = Effect.gen(function* () {
  const invocation = yield* resolveSelfInvocation();
  const bin = NodePath.join(yield* HostProcess.HomeDirectory, ".local", "bin");
  const argv = [invocation.command, ...selfInvocationArgs(invocation, [])].map(shellQuote);
  yield* Effect.try(() => {
    NodeFS.mkdirSync(bin, { recursive: true });
    const staged = NodePath.join(bin, `.t3.${process.pid}`);
    NodeFS.writeFileSync(staged, `#!/bin/sh\nexec ${argv.join(" ")} "$@"\n`, { mode: 0o755 });
    NodeFS.renameSync(staged, NodePath.join(bin, "t3"));
  });
});

/**
 * Runs `request` in a copy of its worktree on this host's own Modal backend, writing the
 * command's output as it comes.
 */
const runInWorktreeCopy = Effect.fn("ForkExec.runInWorktreeCopy")(function* (
  request: ForkExecRequest,
  write: (event: ForkExecEvent) => void,
) {
  const outcome = yield* (yield* WorktreeForks.WorktreeForks).exec(request, {
    started: (jobId) => Effect.sync(() => write({ kind: "started", batchId: jobId, live: true })),
    output: (stream, text) => write({ kind: "output", stream, text }),
  });
  writeOutcome(outcome, write);
});

/** Joins a worktree copy a previous run of this server started, after the caller reconnects. */
const attachToWorktreeCopy = Effect.fn("ForkExec.attachToWorktreeCopy")(function* (
  attach: ForkExecAttach,
  write: (event: ForkExecEvent) => void,
) {
  const outcome = yield* (yield* WorktreeForks.WorktreeForks).attach(
    attach.attach,
    { stdout: attach.stdoutBytes, stderr: attach.stderrBytes },
    (stream, text) => write({ kind: "output", stream, text }),
  );
  if (outcome === null)
    return write({ kind: "failed", message: `This server has no job ${attach.attach} to rejoin.` });
  writeOutcome(outcome, write);
});

const writeOutcome = (
  outcome: WorktreeForks.ExecOutcome,
  write: (event: ForkExecEvent) => void,
) => {
  switch (outcome._tag) {
    case "Exited":
      return write({
        kind: "exited",
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        durationMs: outcome.durationMs,
        stdoutTail: "",
        stderrTail: "",
      });
    case "NotStarted":
      return write({ kind: "unavailable", message: outcome.message });
    case "Lost":
      return write({ kind: "failed", message: outcome.message });
  }
};

/**
 * Makes `~/.local/bin/bun` this host's bun shim, or puts back what it replaced. A cloud box has
 * neither.
 */
const reconcileShim = Effect.fn("ForkExec.reconcileShim")(
  function* (owner: string, want: WorktreeForks.WorktreeForks["Service"]["bunShim"]) {
    const bin = NodePath.join(yield* HostProcess.HomeDirectory, ".local", "bin");
    const changes = yield* Effect.try(() => reconcileBunShim(bin, owner, want));
    if (changes.includes("conflict"))
      yield* Effect.logWarning(
        "bun test is not offloaded: ~/.local/bin/bun and ~/.local/bin/.bun.t3-real both exist and neither is T3's shim",
      );
    else if (changes.length > 0) yield* Effect.logInfo("bun shim updated", { changes });
  },
  (effect) =>
    effect.pipe(
      Effect.tapCause((cause) => Effect.logWarning("bun shim could not be updated", { cause })),
      Effect.ignore,
    ),
);

/** What either backend runs with. */
type Backends =
  | FleetBroker.FleetBroker
  | ServerEnvironment.ServerEnvironment
  | ServerConfig
  | WorktreeForks.WorktreeForks;

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([ForkExecRequest, ForkExecAttach])),
);
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ForkExecEvent));

/**
 * Serves the socket on a Linux cloud box, through its host, and on a self-hosted server with
 * worktree forks, through its own Modal backend. One connection carries one request; closing it
 * cancels the command.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const forks = yield* WorktreeForks.WorktreeForks;
    const { baseDir } = yield* ServerConfig;
    const onCloudBox = Boolean(environment.T3CODE_USAGE_HOST_ID?.trim());
    if (!onCloudBox && platform !== "win32")
      yield* reconcileShim(baseDir, forks.enabled ? forks.bunShim : null);
    const relays = onCloudBox && platform === "linux";
    if (!relays && !forks.enabled) return;
    const path = forkExecSocketPath(baseDir);
    const context = yield* Effect.context<Backends>();
    const serve = (socket: NodeNet.Socket) => {
      const write = (event: ForkExecEvent) => void socket.write(`${encodeEvent(event)}\n`);
      const emit = (event: ForkExecEvent) => Effect.sync(() => write(event));
      const run = (
        request: ForkExecRequest | ForkExecAttach,
      ): Effect.Effect<void, never, Backends> =>
        "attach" in request
          ? relays
            ? emit({ kind: "failed", message: "A copy of this machine cannot be rejoined." })
            : attachToWorktreeCopy(request, write)
          : relays
            ? runInFork(request, emit)
            : runInWorktreeCopy(request, write);
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline === -1 && buffered.length <= MAX_REQUEST_BYTES) return;
        socket.off("data", onData);
        const fiber = Effect.runForkWith(context)(
          decodeRequest(newline === -1 ? "" : buffered.slice(0, newline)).pipe(
            Effect.matchEffect({
              onFailure: () => emit({ kind: "unavailable", message: "The request was malformed." }),
              onSuccess: run,
            }),
            Effect.ensuring(Effect.sync(() => socket.end())),
          ),
        );
        socket.once("close", () => Effect.runFork(Fiber.interrupt(fiber)));
      };
      socket.on("data", onData);
      socket.on("error", () => socket.destroy());
    };
    yield* linkT3Command.pipe(
      Effect.tapCause((cause) => Effect.logWarning("t3 command could not be linked", { cause })),
      Effect.ignore,
    );
    yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server, Error>((resume) => {
        NodeFS.rmSync(path, { force: true });
        const server = NodeNet.createServer(serve);
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(path, () => {
          NodeFS.chmodSync(path, 0o600);
          resume(Effect.succeed(server));
        });
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          NodeFS.rmSync(path, { force: true });
        }),
    ).pipe(
      Effect.tapCause((cause) =>
        Effect.logWarning("fork-exec socket could not start", { path, cause }),
      ),
      Effect.ignore,
    );
  }),
);
