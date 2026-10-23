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
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetBroker from "./FleetBroker.ts";
import * as ForkExec from "./ForkExec.ts";
import { type ForkExecRequest, forkExecSocketPath } from "./forkExecProtocol.ts";
import * as WorktreeForks from "./WorktreeForks.ts";

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
            Layer.mock(WorktreeForks.WorktreeForks)({ enabled: false, bunShim: null }),
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

/**
 * A self-hosted server, not a cloud box, whose worktree forks backend is `forks`, with its T3
 * home, its user's home and the environment its agents inherit.
 */
const onSelfHostedServer = (
  forks: Partial<WorktreeForks.WorktreeForks["Service"]> & { readonly enabled: boolean },
  environment: NodeJS.ProcessEnv = {},
  dirs: { readonly home: string; readonly userHome: string } = {
    home: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fx-")),
    userHome: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3fx-user-")),
  },
) =>
  Effect.gen(function* () {
    const { home, userHome } = dirs;
    yield* Layer.build(
      ForkExec.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(FleetBroker.FleetBroker)({}),
            ServerConfig.layerTest(process.cwd(), home).pipe(Layer.provide(NodeServices.layer)),
            Layer.mock(ServerEnvironment.ServerEnvironment)({}),
            Layer.mock(WorktreeForks.WorktreeForks)({
              bunShim: { skipWhenSet: [], minTestFiles: 20 },
              ...forks,
            }),
            NodeServices.layer,
          ),
        ),
        Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, userHome)),
        Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
      ),
    );
    return { home, userHome, socketPath: forkExecSocketPath(home) };
  });

/** Sends one request over the socket and collects each line it answers, until `stop` says so. */
const send = (
  socketPath: string,
  stop: (lines: ReadonlyArray<string>) => boolean = () => false,
  overrides: Partial<ForkExecRequest> = {},
) =>
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
    socket.write(
      `${JSON.stringify({
        command: "bun run check:types",
        cwd: "/workspace",
        environment: { NODE_OPTIONS: "--max-old-space-size=8192 'x'" },
        ...overrides,
      })}\n`,
    );
    return { lines, closed };
  });

it.effect("runs a command from a box process as a one-job fork for the box's own chat", () =>
  Effect.gen(function* () {
    const { broker, requests, socketPath } = yield* onBox(forks(true));
    const { lines, closed } = yield* send(socketPath);

    const run = yield* Queue.take(requests);
    expect(run.invoke.actor).toEqual({ environmentId: box, threadId: owner });
    expect(run.invoke.request.op).toBe("forks.run");
    const [job] = run.invoke.request.op === "forks.run" ? run.invoke.request.input.jobs : [];
    // The copy's shell sources the caller's environment from a file the copy was taken with.
    const sourced = /^\. (\S+) && bun run check:types$/.exec(job!.command)?.[1];
    expect(sourced).toBeDefined();
    const environmentFile = sourced!.replace(/^'|'$/g, "");
    expect(
      NodeChildProcess.execFileSync(
        "/bin/sh",
        ["-c", `${job!.command.replace("bun run check:types", 'printf %s "$NODE_OPTIONS"')}`],
        { env: {} },
      ).toString(),
    ).toBe("--max-old-space-size=8192 'x'");
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
    expect(NodeFS.existsSync(environmentFile)).toBe(false);
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

it.effect("tells the caller to run it here when it wants outputs back from a box's copy", () =>
  Effect.gen(function* () {
    const { requests, socketPath } = yield* onBox(forks(true));
    const { lines, closed } = yield* send(socketPath, undefined, { outputs: ["/workspace/out"] });
    yield* Deferred.await(closed);
    expect((yield* Queue.takeAll(lines)).map((line) => JSON.parse(line))).toEqual([
      { kind: "unavailable", message: "A copy of this machine cannot bring outputs back." },
    ]);
    expect(yield* Queue.size(requests)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer)))),
);

const answered = (lines: Queue.Queue<string>) =>
  Queue.takeAll(lines).pipe(Effect.map((all) => all.map((line) => JSON.parse(line))));

it.effect("on a self-hosted server it streams the copy's output, then its exit", () =>
  Effect.gen(function* () {
    const received: Array<ForkExecRequest> = [];
    const { socketPath } = yield* onSelfHostedServer({
      enabled: true,
      exec: (request, observer) =>
        Effect.gen(function* () {
          received.push(request);
          yield* observer.started("job-1");
          observer.output("stdout", "pass\n");
          observer.output("stderr", "warn\n");
          return { _tag: "Exited", exitCode: 2, timedOut: false, durationMs: 50 } as const;
        }),
    });
    const { lines, closed } = yield* send(socketPath);
    yield* Deferred.await(closed);
    expect(yield* answered(lines)).toEqual([
      { kind: "started", batchId: "job-1", live: true },
      { kind: "output", stream: "stdout", text: "pass\n" },
      { kind: "output", stream: "stderr", text: "warn\n" },
      {
        kind: "exited",
        exitCode: 2,
        timedOut: false,
        durationMs: 50,
        stdoutTail: "",
        stderrTail: "",
      },
    ]);
    expect(received).toEqual([
      {
        command: "bun run check:types",
        cwd: "/workspace",
        environment: { NODE_OPTIONS: "--max-old-space-size=8192 'x'" },
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a copy that never started is unavailable, and one lost after starting failed", () =>
  Effect.gen(function* () {
    for (const [outcome, kinds] of [
      [{ _tag: "NotStarted", message: "no base yet" }, ["unavailable"]],
      [{ _tag: "Lost", message: "gone" }, ["started", "failed"]],
    ] as const) {
      const { socketPath } = yield* onSelfHostedServer({
        enabled: true,
        exec: (_, observer) =>
          (outcome._tag === "Lost" ? observer.started("job-1") : Effect.void).pipe(
            Effect.as(outcome),
          ),
      });
      const { lines, closed } = yield* send(socketPath);
      yield* Deferred.await(closed);
      const events = yield* answered(lines);
      expect(events.map((event) => event.kind)).toEqual(kinds);
      expect(events.at(-1).message).toBe(outcome.message);
    }
  }).pipe(Effect.scoped),
);

it.effect("a caller rejoining after a restart gets the rest of the output and the outcome", () =>
  Effect.gen(function* () {
    const asked: Array<unknown> = [];
    const { socketPath } = yield* onSelfHostedServer({
      enabled: true,
      attach: (jobId, seen, output) =>
        Effect.sync(() => {
          asked.push([jobId, seen]);
          if (jobId !== "job-1") return null;
          output("stdout", "pass 2\n");
          return { _tag: "Exited", exitCode: 3, timedOut: false, durationMs: 50 } as const;
        }),
    });
    const rejoin = (jobId: string) =>
      Effect.gen(function* () {
        const socket = NodeNet.createConnection(socketPath);
        const closed = yield* Deferred.make<string>();
        let answered = "";
        socket.on("data", (chunk) => (answered += chunk.toString("utf8")));
        socket.on("close", () => Deferred.doneUnsafe(closed, Effect.succeed(answered)));
        socket.write(`${JSON.stringify({ attach: jobId, stdoutBytes: 7, stderrBytes: 0 })}\n`);
        const lines = yield* Deferred.await(closed);
        return lines
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      });
    expect(yield* rejoin("job-1")).toEqual([
      { kind: "output", stream: "stdout", text: "pass 2\n" },
      {
        kind: "exited",
        exitCode: 3,
        timedOut: false,
        durationMs: 50,
        stdoutTail: "",
        stderrTail: "",
      },
    ]);
    expect(yield* rejoin("job-2")).toEqual([
      { kind: "failed", message: "This server has no job job-2 to rejoin." },
    ]);
    expect(asked).toEqual([
      ["job-1", { stdout: 7, stderr: 0 }],
      ["job-2", { stdout: 7, stderr: 0 }],
    ]);
  }).pipe(Effect.scoped),
);

it.effect("closing the connection ends the copy", () =>
  Effect.gen(function* () {
    const ended = yield* Deferred.make<void>();
    const { socketPath } = yield* onSelfHostedServer({
      enabled: true,
      exec: (_, observer) =>
        observer.started("job-1").pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(ended, undefined)),
        ),
    });
    yield* send(socketPath, (seen) => seen.length === 1);
    yield* Deferred.await(ended);
  }).pipe(Effect.scoped),
);

it.effect(
  "installs the bun shim with worktree forks and, without them, serves nothing and removes it",
  () =>
    Effect.gen(function* () {
      const on = yield* Effect.scoped(onSelfHostedServer({ enabled: true }));
      const shim = NodePath.join(on.userHome, ".local", "bin", "bun");
      expect(NodeFS.readFileSync(shim, "utf8")).toContain("# t3-bun-shim 1");
      expect(NodeFS.existsSync(NodePath.join(on.userHome, ".local", "bin", "t3"))).toBe(true);

      const off = yield* onSelfHostedServer({ enabled: false, bunShim: null }, {}, on);
      expect(NodeFS.existsSync(off.socketPath)).toBe(false);
      expect(NodeFS.existsSync(shim)).toBe(false);
    }).pipe(Effect.scoped),
);
