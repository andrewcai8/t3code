// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - starts the host with an IPC channel and adopts the sockets it hands over, which ChildProcess.make cannot express. Its answer deadlines are timers on that event-driven channel.
/**
 * Before libuv 1.53, Node starts every child on Linux with fork(), which copies the page tables
 * of the whole server on its main thread. At the server's usual 1.5 GB that blocks the event
 * loop for 10 to 30 ms per process, and the server starts several each second
 * (pingdotgg/t3code#21289). This spawner hands every spawn to a small host process, forked once
 * while the server is still small. Children read and write their stdio sockets in the server
 * directly, and the server signals them by pid; only the exit status comes from the host.
 *
 * Once the Node that T3 Code ships bundles libuv 1.53 (posix_spawn), `spawnsThroughHost` turns
 * this off. Then delete this module, `spawnHostProcess.ts`, the `__spawn-host` command, and the
 * host's case in `ProcessGroupMetrics`.
 */
import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeURL from "node:url";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  SPAWN_HOST_COMMAND,
  type SpawnHostError,
  type SpawnHostEvent,
  type SpawnHostRequest,
  type SpawnHostStdio,
} from "./spawnHostProcess.ts";

/** The one gate: hosted spawning only where Node still forks the server. */
export const spawnsThroughHost = (platform: NodeJS.Platform, libuvVersion: string): boolean => {
  const [major = 0, minor = 0] = libuvVersion.split(".").map(Number);
  return platform === "linux" && (major < 1 || (major === 1 && minor < 53));
};

export interface SpawnHostCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

type ExitStatus = readonly [code: number | null, signal: NodeJS.Signals | null];

type SpawnOutcome =
  | {
      readonly _tag: "Spawned";
      readonly pid: number;
      readonly stdio: ReadonlyArray<NodeNet.Socket | undefined>;
    }
  | { readonly _tag: "Failed"; readonly error: NodeJS.ErrnoException; readonly thrown: boolean }
  | { readonly _tag: "HostLost" };

interface SpawnListener {
  readonly started: (outcome: SpawnOutcome) => void;
  /** `undefined` when the host died before reporting the exit. */
  readonly exited: (status: ExitStatus | undefined) => void;
}

interface PendingSpawn {
  readonly listener: SpawnListener;
  readonly deadline: NodeJS.Timeout;
  readonly stdio: Array<NodeNet.Socket | undefined>;
  pipesLeft: number;
  pid: number | undefined;
  started: boolean;
  abandoned: boolean;
}

/**
 * A healthy host answers in milliseconds, so these only have to outlast a stall short of a hang
 * (a loaded machine, a cold Node start). Waiting happens inside an uninterruptible acquire, so
 * without them one wedged host would block every spawn.
 */
export interface SpawnHostDeadlines {
  /** From starting the host to its `ready`. */
  readonly readyMillis: number;
  /** From sending a request to receiving `spawned` and every stdio handle. */
  readonly spawnMillis: number;
}

const DEFAULT_DEADLINES: SpawnHostDeadlines = { readyMillis: 30_000, spawnMillis: 30_000 };

const MAX_HOST_DEATHS = 3;
const PROCESS_GROUP_GRACE_MILLIS = 1_000;
const PROCESS_GROUP_POLL_MILLIS = 10;

const killQuietly = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
};

const toErrnoException = (fields: SpawnHostError): NodeJS.ErrnoException =>
  Object.assign(new Error(fields.message), {
    code: fields.code,
    errno: fields.errno,
    syscall: fields.syscall,
    path: fields.path,
    spawnargs: fields.spawnargs,
  });

/** One running host process and the spawns it owes answers for. */
class HostConnection {
  readonly ready = Deferred.makeUnsafe<boolean>();
  readonly #process: NodeChildProcess.ChildProcess;
  readonly #pending = new Map<number, PendingSpawn>();
  readonly #deadlines: SpawnHostDeadlines;
  readonly #onLost: (wasReady: boolean) => void;
  readonly #readyDeadline: NodeJS.Timeout;
  #nextId = 0;
  #wasReady = false;
  #lost = false;

  constructor(
    host: SpawnHostCommand,
    deadlines: SpawnHostDeadlines,
    onLost: (wasReady: boolean) => void,
  ) {
    this.#deadlines = deadlines;
    this.#onLost = onLost;
    this.#process = NodeChildProcess.spawn(host.command, [...host.args], {
      // Under Electron, execPath is the app; this makes it run the entry as Node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    this.#process.on("message", this.#onMessage);
    // `disconnect` comes after every message the host sent, so nothing in flight is lost.
    this.#process.once("disconnect", this.#lose);
    this.#process.once("error", this.#lose);
    this.#readyDeadline = this.#startDeadline(deadlines.readyMillis);
  }

  spawn(request: Omit<SpawnHostRequest, "id">, listener: SpawnListener): () => void {
    if (this.#lost) {
      listener.started({ _tag: "HostLost" });
      return () => {};
    }
    const id = this.#nextId++;
    const pending: PendingSpawn = {
      listener,
      deadline: this.#startDeadline(this.#deadlines.spawnMillis),
      stdio: [],
      pipesLeft: request.stdio.filter((stdio) => stdio === "pipe").length,
      pid: undefined,
      started: false,
      abandoned: false,
    };
    this.#pending.set(id, pending);
    // A failed send means the channel is closing; `disconnect` answers this spawn.
    this.#process.send({ ...request, id } satisfies SpawnHostRequest, () => {});
    return () => {
      if (pending.started) return;
      pending.abandoned = true;
      if (pending.pid !== undefined) killQuietly(pending.pid, "SIGTERM");
      for (const socket of pending.stdio) socket?.destroy();
    };
  }

  close() {
    if (this.#process.connected) this.#process.disconnect();
  }

  // An unanswered host is replaced: killing it fails what it still owes through `#lose`.
  #startDeadline(millis: number) {
    const timer = setTimeout(() => {
      this.#process.kill("SIGKILL");
      this.#lose();
    }, millis);
    timer.unref();
    return timer;
  }

  readonly #onMessage = (message: unknown, handle: unknown) => {
    const event = message as SpawnHostEvent;
    if (event.type === "ready") {
      clearTimeout(this.#readyDeadline);
      this.#wasReady = true;
      Deferred.doneUnsafe(this.ready, Exit.succeed(true));
      return;
    }
    const pending = this.#pending.get(event.id);
    if (pending === undefined) {
      // The spawn was already answered; close the handle rather than leak its descriptor.
      if (event.type === "stdio") (handle as NodeNet.Socket).destroy();
      return;
    }
    switch (event.type) {
      case "spawned":
        pending.pid = event.pid;
        if (pending.abandoned) killQuietly(event.pid, "SIGTERM");
        break;
      case "stdio": {
        const socket = handle as NodeNet.Socket;
        if (pending.abandoned) socket.destroy();
        else pending.stdio[event.fd] = socket;
        pending.pipesLeft--;
        break;
      }
      case "exit":
        this.#pending.delete(event.id);
        clearTimeout(pending.deadline);
        if (pending.abandoned) return;
        if (pending.started) {
          pending.listener.exited([event.code, event.signal]);
          return;
        }
        // The host sends `exit` after every handle, so this host broke its protocol. The child
        // is already reaped, so its pid is not signalled: it may belong to a stranger now.
        for (const socket of pending.stdio) socket?.destroy();
        pending.listener.started({ _tag: "HostLost" });
        return;
      case "error":
        this.#pending.delete(event.id);
        clearTimeout(pending.deadline);
        if (!pending.abandoned) {
          pending.listener.started({
            _tag: "Failed",
            error: toErrnoException(event.error),
            thrown: event.thrown,
          });
        }
        return;
    }
    if (pending.pipesLeft === 0 && pending.pid !== undefined && !pending.started) {
      pending.started = true;
      clearTimeout(pending.deadline);
      if (!pending.abandoned) {
        pending.listener.started({ _tag: "Spawned", pid: pending.pid, stdio: pending.stdio });
      }
    }
  };

  readonly #lose = () => {
    if (this.#lost) return;
    this.#lost = true;
    clearTimeout(this.#readyDeadline);
    Deferred.doneUnsafe(this.ready, Exit.succeed(false));
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.deadline);
      if (pending.abandoned) continue;
      if (pending.started) {
        pending.listener.exited(undefined);
        continue;
      }
      // Half-started: the caller never gets this child, so it must not outlive the spawn.
      if (pending.pid !== undefined) killQuietly(pending.pid, "SIGTERM");
      for (const socket of pending.stdio) socket?.destroy();
      pending.listener.started({ _tag: "HostLost" });
    }
    this.#pending.clear();
    this.#onLost(this.#wasReady);
  };
}

type HostState =
  | { readonly _tag: "Up"; readonly connection: HostConnection }
  | { readonly _tag: "Down" }
  | { readonly _tag: "Off"; readonly unreported: boolean };

/**
 * Starts the host now, while the caller is small, and replaces it lazily if it dies. A host
 * that never became ready, or that died too often, turns hosting off: spawns go direct.
 */
const makeHostSupervisor = (host: SpawnHostCommand, deadlines: SpawnHostDeadlines) => {
  let state: HostState = { _tag: "Down" };
  let deaths = 0;

  const start = (): HostConnection | undefined => {
    try {
      const connection: HostConnection = new HostConnection(host, deadlines, (wasReady) => {
        if (state._tag !== "Up" || state.connection !== connection) return;
        deaths++;
        state =
          wasReady && deaths < MAX_HOST_DEATHS
            ? { _tag: "Down" }
            : { _tag: "Off", unreported: true };
      });
      state = { _tag: "Up", connection };
      return connection;
    } catch {
      // Node throws from spawn for some failures; the server must still start.
      state = { _tag: "Off", unreported: true };
      return undefined;
    }
  };
  start();

  const awaitReady = (connection: HostConnection): Effect.Effect<HostConnection | undefined> =>
    Deferred.await(connection.ready).pipe(
      Effect.flatMap((ready) => (ready ? Effect.succeed(connection) : acquire)),
    );

  const acquire: Effect.Effect<HostConnection | undefined> = Effect.suspend(() => {
    switch (state._tag) {
      case "Up":
        return awaitReady(state.connection);
      case "Down": {
        const connection = start();
        return Effect.logWarning("Spawn host exited; started a new one.").pipe(
          Effect.andThen(connection === undefined ? acquire : awaitReady(connection)),
        );
      }
      case "Off":
        if (!state.unreported) return Effect.succeed(undefined);
        state = { _tag: "Off", unreported: false };
        return Effect.logWarning(
          "Spawn host is unavailable; child processes now fork the server.",
        ).pipe(Effect.as(undefined));
    }
  });

  const close = () => {
    const current = state;
    state = { _tag: "Off", unreported: false };
    if (current._tag === "Up") current.connection.close();
  };

  return { acquire, close };
};

const errnoReason = (code: string | undefined): PlatformError.SystemErrorTag => {
  switch (code) {
    case "ENOENT":
      return "NotFound";
    case "EACCES":
      return "PermissionDenied";
    case "EEXIST":
      return "AlreadyExists";
    case "EISDIR":
    case "ENOTDIR":
    case "ELOOP":
      return "BadResource";
    case "EBUSY":
      return "Busy";
    default:
      return "Unknown";
  }
};

/** The same errors the Node spawner reports, so callers' handling is unchanged. */
const toPlatformError = (
  method: string,
  error: NodeJS.ErrnoException,
  command: ChildProcess.StandardCommand,
) =>
  PlatformError.systemError({
    _tag: errnoReason(error.code),
    module: "ChildProcess",
    method,
    pathOrDescriptor: `${command.command} ${command.args.join(" ")}`,
    syscall: error.syscall,
    cause: error,
  });

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const hostLostError = (method: string, command: ChildProcess.StandardCommand) =>
  toPlatformError(
    method,
    new Error("The spawn host exited before reporting on the process."),
    command,
  );

// Buffered writes can fail after the sink stopped listening; keep a listener until close.
const handleInputErrors = (writable: NodeStream.Writable) => {
  const onError = () => {};
  writable.on("error", onError);
  writable.once("close", () => writable.off("error", onError));
};

const toStdio = (stream: unknown): SpawnHostStdio =>
  stream === "inherit" || stream === "ignore" ? stream : "pipe";

const resolveStdin = (options: ChildProcess.CommandOptions): ChildProcess.StdinConfig => {
  const defaults = { stream: "pipe", encoding: "utf-8", endOnDone: true } as const;
  const stdin = options.stdin;
  if (stdin === undefined) return defaults;
  if (typeof stdin === "string" || Stream.isStream(stdin)) return { ...defaults, stream: stdin };
  return {
    stream: stdin.stream,
    encoding: stdin.encoding ?? defaults.encoding,
    endOnDone: stdin.endOnDone ?? defaults.endOnDone,
  };
};

const resolveOutput = (
  option: ChildProcess.CommandOptions["stdout"],
): ChildProcess.StdoutConfig["stream"] => {
  if (option === undefined) return "pipe";
  if (typeof option === "string" || Sink.isSink(option)) return option;
  return option.stream;
};

const make = Effect.fn("SpawnHost.make")(function* (
  host: SpawnHostCommand,
  deadlines: SpawnHostDeadlines,
) {
  const direct = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supervisor = makeHostSupervisor(host, deadlines);
  yield* Effect.addFinalizer(() => Effect.sync(supervisor.close));

  const readOutput = (
    command: ChildProcess.StandardCommand,
    socket: NodeNet.Socket | undefined,
    name: "stdout" | "stderr",
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError> => {
    if (socket === undefined) return Stream.empty;
    const passThrough = new NodeStream.PassThrough();
    socket.on("error", (error) => passThrough.destroy(error));
    socket.pipe(passThrough);
    return EffectNodeStream.fromReadable({
      evaluate: () => passThrough,
      onError: (error) => toPlatformError(`fromReadable(${name})`, toError(error), command),
    });
  };

  // Untraced like the Node spawner it replaces: callers trace their own process runs.
  const spawnHosted = Effect.fnUntraced(function* (
    connection: HostConnection,
    command: ChildProcess.StandardCommand,
  ) {
    const options = command.options;
    const stdinConfig = resolveStdin(options);
    const stdoutConfig = resolveOutput(options.stdout);
    const stderrConfig = resolveOutput(options.stderr);
    let cwd = process.cwd();
    if (options.cwd !== undefined) {
      yield* fileSystem.access(options.cwd);
      cwd = path.resolve(options.cwd);
    }
    const env = options.extendEnv
      ? { ...process.env, ...options.env }
      : (options.env ?? process.env);
    const killSignal = options.killSignal ?? "SIGTERM";
    const exit = Deferred.makeUnsafe<ExitStatus, PlatformError.PlatformError>();
    // Set only by a reported exit; a lost host leaves it unset with `exit` failed.
    let exitStatus: ExitStatus | undefined;
    let spawned: Extract<SpawnOutcome, { _tag: "Spawned" }> | undefined;
    let isReferenced = true;

    const start = Effect.callback<
      Extract<SpawnOutcome, { _tag: "Spawned" }>,
      PlatformError.PlatformError
    >((resume) => {
      const abandon = connection.spawn(
        {
          command: command.command,
          args: command.args,
          cwd,
          env,
          stdio: [toStdio(stdinConfig.stream), toStdio(stdoutConfig), toStdio(stderrConfig)],
          detached: options.detached ?? true,
          shell: options.shell,
        },
        {
          started: (outcome) => {
            switch (outcome._tag) {
              case "Spawned":
                spawned = outcome;
                return resume(Effect.succeed(outcome));
              case "Failed":
                return resume(
                  outcome.thrown
                    ? Effect.die(outcome.error)
                    : Effect.fail(toPlatformError("spawn", outcome.error, command)),
                );
              case "HostLost":
                return resume(Effect.fail(hostLostError("spawn", command)));
            }
          },
          exited: (status) => {
            exitStatus = status;
            // As the Node spawner does, a failing child's group is signalled at once.
            const code = status?.[0] ?? null;
            if (spawned !== undefined && code !== 0 && code !== null) {
              killQuietly(-spawned.pid, killSignal);
            }
            Deferred.doneUnsafe(
              exit,
              status === undefined
                ? Exit.fail(hostLostError("exitCode", command))
                : Exit.succeed(status),
            );
          },
        },
      );
      return Effect.sync(abandon);
    });

    const terminateProcessGroup = Effect.fnUntraced(function* (
      pid: number,
      killOptions: ChildProcess.KillOptions | undefined,
    ) {
      const isAlive = () => {
        if (!Deferred.isDoneUnsafe(exit)) return true;
        try {
          process.kill(-pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const gone: Effect.Effect<void> = Effect.suspend(() =>
        isAlive() ? Effect.andThen(Effect.sleep(PROCESS_GROUP_POLL_MILLIS), gone) : Effect.void,
      );
      const awaitGone = (timeoutMillis: number) =>
        gone.pipe(Effect.timeoutOption(timeoutMillis), Effect.asVoid);
      const signalGroup = (signal: NodeJS.Signals) =>
        Effect.try({
          try: () => process.kill(-pid, signal),
          catch: (error) => toPlatformError("kill", toError(error), command),
        }).pipe(
          Effect.catch(() =>
            Effect.try({
              try: () => {
                if (exitStatus !== undefined) throw new Error("Failed to kill child process");
                process.kill(pid, signal);
              },
              catch: (error) => toPlatformError("kill", toError(error), command),
            }),
          ),
        );
      yield* signalGroup(killOptions?.killSignal ?? "SIGTERM");
      if (killOptions?.forceKillAfter === undefined) {
        yield* awaitGone(PROCESS_GROUP_GRACE_MILLIS);
      } else {
        yield* awaitGone(Duration.toMillis(killOptions.forceKillAfter));
        if (isAlive()) {
          yield* signalGroup("SIGKILL");
          yield* awaitGone(PROCESS_GROUP_GRACE_MILLIS);
        }
      }
      yield* Effect.exit(Deferred.await(exit));
    });

    // Mirrors the Node spawner's release: stop a running child, a failed one's group, and a
    // detached group left behind by its leader, unless the caller unreferenced the child.
    const child = yield* Effect.acquireRelease(start, ({ pid }) => {
      if (exitStatus === undefined) {
        return isReferenced ? Effect.ignore(terminateProcessGroup(pid, options)) : Effect.void;
      }
      const [code] = exitStatus;
      const lingering =
        (code !== 0 && code !== null) || (isReferenced && options.detached !== false);
      return lingering ? Effect.ignore(terminateProcessGroup(pid, options)) : Effect.void;
    });
    const pid = child.pid;
    const [stdinSocket, stdoutSocket, stderrSocket] = child.stdio;

    let stdin: Sink.Sink<void, unknown, never, PlatformError.PlatformError> = Sink.drain;
    if (stdinSocket !== undefined) {
      handleInputErrors(stdinSocket);
      stdin = NodeSink.fromWritable({
        evaluate: () => stdinSocket,
        onError: (error) => toPlatformError("fromWritable(stdin)", toError(error), command),
        endOnDone: stdinConfig.endOnDone,
        encoding: stdinConfig.encoding,
      });
    }
    if (Stream.isStream(stdinConfig.stream)) {
      yield* Effect.forkScoped(Stream.run(stdinConfig.stream, stdin));
    }

    let stdout = readOutput(command, stdoutSocket, "stdout");
    let stderr = readOutput(command, stderrSocket, "stderr");
    if (Sink.isSink(stdoutConfig)) stdout = Stream.transduce(stdout, stdoutConfig);
    if (Sink.isSink(stderrConfig)) stderr = Stream.transduce(stderr, stderrConfig);

    const reref = Effect.sync(() => {
      isReferenced = true;
    });

    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode: Effect.flatMap(Deferred.await(exit), ([code, signal]) =>
        code !== null
          ? Effect.succeed(ChildProcessSpawner.ExitCode(code))
          : Effect.fail(
              toPlatformError(
                "exitCode",
                new Error(`Process interrupted due to receipt of signal: '${signal}'`),
                command,
              ),
            ),
      ),
      isRunning: Effect.map(Deferred.isDone(exit), (done) => !done),
      kill: (killOptions) => terminateProcessGroup(pid, killOptions),
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      // The host's channel, not the child, keeps the event loop alive here; unref only
      // stops scope cleanup from stopping the child, as with the Node spawner.
      unref: Effect.sync(() => {
        isReferenced = false;
        return reref;
      }),
    });
  });

  // Pipelines and extra fds are rare and need Node's own stdio wiring; they spawn directly.
  const spawn = (command: ChildProcess.Command) =>
    command._tag === "StandardCommand" && command.options.additionalFds === undefined
      ? supervisor.acquire.pipe(
          Effect.flatMap((connection) =>
            connection === undefined ? direct.spawn(command) : spawnHosted(connection, command),
          ),
        )
      : direct.spawn(command);

  return ChildProcessSpawner.make(spawn);
});

/** Always spawns through a host started with `host`, falling back to Node when it cannot. */
export const layerHosted = (
  host: SpawnHostCommand,
  deadlines: SpawnHostDeadlines = DEFAULT_DEADLINES,
) =>
  Layer.effect(ChildProcessSpawner.ChildProcessSpawner, make(host, deadlines)).pipe(
    Layer.provide(NodeChildProcessSpawner.layer),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    if (!spawnsThroughHost(platform, process.versions.uv)) return NodeChildProcessSpawner.layer;
    const executablePath = yield* HostProcess.ExecutablePath;
    // A single executable dispatches its own argv; otherwise rerun the CLI entry beside us.
    const fromSource = import.meta.url.endsWith(".ts");
    const entry = NodeURL.fileURLToPath(
      new URL(fromSource ? "../bin.ts" : "./bin.mjs", import.meta.url),
    );
    const args = (yield* HostProcess.IsExecutable) ? [] : [entry];
    return layerHosted({ command: executablePath, args: [...args, SPAWN_HOST_COMMAND] });
  }),
);
