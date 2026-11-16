// @effect-diagnostics nodeBuiltinImport:off - the spawn host is plain Node so it stays small and starts fast.
/**
 * The spawn host: a small process the server starts once, while its memory is small, that starts
 * every other child process for it (see `SpawnHost.ts`). Each piped stdio of a child goes to the
 * server as a socket handle over IPC, so output never passes through here; only the exit status
 * comes from here, because only the parent can wait for it.
 */
import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";

/** The CLI argument that starts a spawn host instead of the CLI. */
export const SPAWN_HOST_COMMAND = "__spawn-host";

export type SpawnHostStdio = "pipe" | "ignore" | "inherit";

export interface SpawnHostRequest {
  readonly id: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdio: ReadonlyArray<SpawnHostStdio>;
  readonly detached: boolean;
  readonly shell: boolean | string | undefined;
}

export interface SpawnHostError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
  readonly spawnargs?: ReadonlyArray<string> | undefined;
}

/**
 * Per request, in order: `spawned`, one `stdio` (carrying the socket) per piped fd, then
 * `exit`. Or a single `error`; `thrown` marks the failures Node throws from `spawn` instead
 * of emitting.
 */
export type SpawnHostEvent =
  | { readonly type: "ready" }
  | { readonly type: "spawned"; readonly id: number; readonly pid: number }
  | { readonly type: "stdio"; readonly id: number; readonly fd: number }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | {
      readonly type: "error";
      readonly id: number;
      readonly thrown: boolean;
      readonly error: SpawnHostError;
    };

const send = (event: SpawnHostEvent, handle?: NodeChildProcess.SendHandle) =>
  new Promise<void>((resolve) => {
    process.send?.(event, handle, undefined, () => resolve());
  });

const errorFields = (error: unknown): SpawnHostError => {
  const fields = error as NodeJS.ErrnoException & { readonly spawnargs?: ReadonlyArray<string> };
  return {
    message: error instanceof Error ? error.message : String(error),
    code: fields.code,
    errno: fields.errno,
    syscall: fields.syscall,
    path: fields.path,
    spawnargs: fields.spawnargs,
  };
};

// Node starts reading an output pipe as soon as it creates it. Bytes read here would stay in
// this process when the socket is handed over, so reading stops before the next poll.
// `Socket.pause` would not stop it: it only stops reading once a chunk is buffered.
interface ReadableHandle {
  reading: boolean;
  readStop(): number;
}

const readableHandle = (pipe: unknown): ReadableHandle | undefined => {
  const handle = (pipe as { _handle?: Partial<ReadableHandle> } | null)?._handle;
  return typeof handle?.readStop === "function" && typeof handle.reading === "boolean"
    ? (handle as ReadableHandle)
    : undefined;
};

const stopReading = (pipe: unknown) => {
  const handle = readableHandle(pipe);
  if (handle?.reading !== true) return;
  handle.reading = false;
  handle.readStop();
};

// `stopReading` leans on Node's private handle. Without it, bytes read here would be lost
// silently, so a host on a Node where it changed shape declines to start instead.
const canStopReading = () => {
  const probe = NodeChildProcess.spawn(process.execPath, ["-e", ""], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  probe.on("error", () => {});
  const capable = readableHandle(probe.stdout) !== undefined;
  probe.stdout?.destroy();
  probe.kill();
  return capable;
};

const spawnChild = (request: SpawnHostRequest) => {
  const { id } = request;
  let child: NodeChildProcess.ChildProcess;
  try {
    child = NodeChildProcess.spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env,
      stdio: [...request.stdio],
      detached: request.detached,
      shell: request.shell,
    });
  } catch (error) {
    void send({ type: "error", id, thrown: true, error: errorFields(error) });
    return;
  }
  if (child.pid === undefined) {
    child.once("error", (error) => {
      void send({ type: "error", id, thrown: false, error: errorFields(error) });
    });
    return;
  }
  // An unhandled `error` event would crash the host and every spawn in flight with it.
  child.on("error", () => {});
  // The pipes now belong to the server. Detached from `child`, Node's exit handling can
  // neither destroy stdin nor resume reading the outputs while their handles wait to be sent.
  const pipes = child.stdio;
  Object.assign(child, { stdio: null, stdin: null, stdout: null, stderr: null });
  for (const pipe of pipes) stopReading(pipe);

  const exited = new Promise<Pick<Extract<SpawnHostEvent, { type: "exit" }>, "code" | "signal">>(
    (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  void send({ type: "spawned", id, pid: child.pid });
  const handedOver = pipes.flatMap((pipe, fd) =>
    pipe === null ? [] : [send({ type: "stdio", id, fd }, pipe as NodeNet.Socket)],
  );
  // Plain messages can overtake queued handles, so the exit waits for every handle.
  void Promise.all([exited, ...handedOver]).then(([status]) =>
    send({ type: "exit", id, ...status }),
  );
};

export const runSpawnHost = () => {
  // No `ready` is sent, so the server sees a host that never started and spawns directly.
  if (!canStopReading()) process.exit(1);
  // Lives exactly as long as the server's IPC channel. Terminal and service-manager signals
  // reach the server, which closes the channel when it is done spawning.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  process.once("disconnect", () => process.exit(0));
  process.on("message", (request) => spawnChild(request as SpawnHostRequest));
  void send({ type: "ready" });
};
