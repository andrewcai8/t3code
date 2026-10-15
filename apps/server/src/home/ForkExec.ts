// @effect-diagnostics nodeBuiltinImport:off - Effect has no Unix socket server.
/**
 * ForkExec - runs one shell command in a throwaway copy of this cloud machine, for any process on it.
 *
 * Whole-repo checks (typechecks, full test suites, builds) push a cloud chat's machine into swap,
 * which stalls every agent on it. `t3 fork-exec -- <command>` hands the command to this service
 * over a Unix socket in T3 home, which only processes on this machine can open. It runs the
 * command as a one-job t3_fork_run batch for the machine's own chat, the one actor its host accepts
 * for forks, waits for it, and answers with the job's exit code and output. Subagents, scripts and
 * every provider reach it the same way, so nothing has to be taught to use it.
 *
 * @module ForkExec
 */
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
import * as FleetBroker from "./FleetBroker.ts";
import { ForkExecEvent, ForkExecRequest, forkExecSocketPath } from "./forkExecProtocol.ts";

const unavailable = (message: string) =>
  new OrchestratorMcpFailure({ code: "environment_unavailable", message });

/**
 * Runs `request` as a one-job batch for this machine's own chat, which its host names in the
 * forks environment it offers. `emit` gets `started` once the batch exists.
 */
const runInFork = (request: ForkExecRequest, emit: (event: ForkExecEvent) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    yield* FleetBroker.awaitHostReconnect;
    const { hostConnected, environments } = yield* broker.reach;
    const owner = environments.find(
      (environment) => environment.environmentId === CLOUD_FORKS_ENVIRONMENT_ID,
    )?.chat?.threadId;
    if (!hostConnected) return yield* unavailable("This machine's host is not connected.");
    if (owner === undefined)
      return yield* unavailable("This machine's host does not offer forks to its own chat.");
    const invoke = (fleetRequest: FleetRequest) =>
      Effect.gen(function* () {
        yield* FleetBroker.awaitHostReconnect;
        return yield* broker.invoke(CLOUD_FORKS_ENVIRONMENT_ID, {
          actor: { environmentId, threadId: owner },
          request: fleetRequest,
        });
      }).pipe(Effect.retry({ while: FleetBroker.isRelayLoss, times: 2 }));

    const { cwd, command, timeoutSeconds } = request;
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
  }).pipe(Effect.catch((error) => emit({ kind: "unavailable", message: error.message })));

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

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

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ForkExecRequest));
const encodeEvent = Schema.encodeSync(Schema.fromJsonString(ForkExecEvent));

/**
 * Serves the socket on a Linux cloud box, the only machine forks copy. One connection carries one
 * request; closing it cancels the batch.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* HostProcess.Environment;
    if (!environment.T3CODE_USAGE_HOST_ID?.trim() || (yield* HostProcess.Platform) !== "linux")
      return;
    const path = forkExecSocketPath((yield* ServerConfig).baseDir);
    const context = yield* Effect.context<
      FleetBroker.FleetBroker | ServerEnvironment.ServerEnvironment
    >();
    const serve = (socket: NodeNet.Socket) => {
      const emit = (event: ForkExecEvent) =>
        Effect.sync(() => void socket.write(`${encodeEvent(event)}\n`));
      let buffered = "";
      const onData = (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const newline = buffered.indexOf("\n");
        if (newline === -1) return;
        socket.off("data", onData);
        const fiber = Effect.runForkWith(context)(
          decodeRequest(buffered.slice(0, newline)).pipe(
            Effect.matchEffect({
              onFailure: () => emit({ kind: "unavailable", message: "The request was malformed." }),
              onSuccess: (request) => runInFork(request, emit),
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
