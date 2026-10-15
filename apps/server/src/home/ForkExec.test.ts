// @effect-diagnostics nodeBuiltinImport:off - a real Unix socket client exercises the server.
import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CLOUD_FORKS_ENVIRONMENT_ID,
  EnvironmentId,
  type FleetEnvironment,
  type FleetHostRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as ForkExec from "./ForkExec.ts";
import { forkExecSocketPath } from "./forkExecProtocol.ts";

const box = EnvironmentId.make("box");
const owner = ThreadId.make("owner-chat");

const forks = (withChat: boolean): FleetEnvironment => ({
  environmentId: CLOUD_FORKS_ENVIRONMENT_ID,
  label: "Throwaway copies of this machine, for t3_fork_run",
  connected: true,
  ...(withChat
    ? {
        chat: {
          threadId: owner,
          title: "Owner",
          status: "idle",
          updatedAt: "2026-10-15T00:00:00.000Z",
        },
      }
    : {}),
});

const running = { batchId: "b1", state: "running", jobs: [{ index: 0, state: "queued" }] };
const finished = {
  batchId: "b1",
  state: "finished",
  jobs: [
    {
      index: 0,
      state: "exited",
      exitCode: 3,
      timedOut: false,
      durationMs: 1200,
      stdoutTail: "2 errors\n",
      stderrTail: "",
      logsUri: "s3://bucket/b1/logs/",
    },
  ],
};

/** A cloud box whose host offers `forksEntry`, with the fork-exec socket serving on it. */
const onBox = (forksEntry: FleetEnvironment) =>
  Effect.gen(function* () {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fx-"));
    const broker = yield* FleetBroker.FleetBroker;
    const requests = yield* Queue.unbounded<FleetHostRequest>();
    yield* Stream.runForEach(
      yield* broker.connect({ clientId: "t3-cloud-host", environments: [forksEntry] }),
      (request) => Queue.offer(requests, request),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Layer.build(
      ForkExec.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(FleetBroker.FleetBroker, broker),
            ServerConfig.layerTest(process.cwd(), home).pipe(Layer.provide(NodeServices.layer)),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(box),
            }),
            NodeServices.layer,
          ),
        ),
        Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
        Layer.provide(Layer.succeed(HostProcess.Environment, { T3CODE_USAGE_HOST_ID: "host" })),
      ),
    );
    return { broker, requests, socketPath: forkExecSocketPath(home) };
  });

/** Sends one request over the socket and collects each line it answers, until `stop` says so. */
const send = (socketPath: string, stop: (lines: ReadonlyArray<string>) => boolean = () => false) =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    const closed = yield* Deferred.make<void>();
    const socket = NodeNet.createConnection(socketPath);
    const seen: Array<string> = [];
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        seen.push(buffered.slice(0, newline));
        Queue.offerUnsafe(lines, buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (stop(seen)) socket.destroy();
      }
    });
    socket.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
    socket.write(`${JSON.stringify({ command: "bun run check:types", cwd: "/workspace" })}\n`);
    return { lines, closed };
  });

it.effect("runs a command from a box process as a one-job fork for the box's own chat", () =>
  Effect.gen(function* () {
    const { broker, requests, socketPath } = yield* onBox(forks(true));
    const { lines, closed } = yield* send(socketPath);

    const run = yield* Queue.take(requests);
    expect(run.invoke).toEqual({
      actor: { environmentId: box, threadId: owner },
      request: {
        op: "forks.run",
        input: { jobs: [{ command: "bun run check:types", cwd: "/workspace" }] },
      },
    });
    yield* broker.respond({ requestId: run.requestId, result: running });
    const status = yield* Queue.take(requests);
    expect(status.invoke.request).toEqual({
      op: "forks.status",
      input: { batchId: "b1", waitSeconds: 45 },
    });
    yield* broker.respond({ requestId: status.requestId, result: finished });
    yield* Deferred.await(closed);

    expect((yield* Queue.takeAll(lines)).map((line) => JSON.parse(line))).toEqual([
      { kind: "started", batchId: "b1" },
      {
        kind: "exited",
        exitCode: 3,
        timedOut: false,
        durationMs: 1200,
        stdoutTail: "2 errors\n",
        stderrTail: "",
        logsUri: "s3://bucket/b1/logs/",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("cancels the copy when the process waiting on it goes away", () =>
  Effect.gen(function* () {
    const { broker, requests, socketPath } = yield* onBox(forks(true));
    yield* send(socketPath, (seen) => seen.length === 1);
    const run = yield* Queue.take(requests);
    yield* broker.respond({ requestId: run.requestId, result: running });
    expect((yield* Queue.take(requests)).invoke.request.op).toBe("forks.status");
    const cancel = yield* Queue.take(requests);
    expect(cancel.invoke.request).toEqual({ op: "forks.cancel", input: { batchId: "b1" } });
  }).pipe(Effect.scoped, Effect.provide(FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

it.effect("tells the caller to run it here when the host offers no forks to the box's chat", () =>
  Effect.gen(function* () {
    const { requests, socketPath } = yield* onBox(forks(false));
    const { lines, closed } = yield* send(socketPath);
    yield* Deferred.await(closed);
    expect((yield* Queue.takeAll(lines)).map((line) => JSON.parse(line).kind)).toEqual([
      "unavailable",
    ]);
    expect(yield* Queue.size(requests)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);
