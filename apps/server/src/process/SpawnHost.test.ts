import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as ProcessRunner from "../processRunner.ts";
import * as SpawnHost from "./SpawnHost.ts";

const hostCommand = {
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)), "__spawn-host"],
};

const layerHosted = (host: SpawnHost.SpawnHostCommand = hostCommand) =>
  SpawnHost.layerHosted(host).pipe(Layer.provideMerge(NodeServices.layer));

const layerDirect = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const sh = (script: string, options?: ChildProcess.CommandOptions) =>
  ChildProcess.make("sh", ["-c", script], options);

const text = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText, Stream.mkString);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const run = (command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(command);
    const [stdout, stderr, code] = yield* Effect.all(
      [text(handle.stdout), text(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, code: Number(code) };
  }).pipe(Effect.scoped);

/** What a caller can tell apart: output and exit code, or the error type and errno. */
const observe = (command: ChildProcess.Command) =>
  run(command).pipe(
    Effect.exit,
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.squash(exit.cause);
      const errno = (cause: unknown) => (cause as NodeJS.ErrnoException | undefined)?.code;
      return failure instanceof PlatformError.PlatformError
        ? { error: failure.reason._tag, errno: errno(failure.reason.cause) }
        : { defect: errno(failure) };
    }),
  );

const firstLine = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runHead,
    Effect.map((line) => Number(Option.getOrThrow(line))),
  );

/** The pid of whatever process forked the child: the host, or this process itself. */
const forkingPid = run(sh("echo $PPID")).pipe(Effect.map(({ stdout }) => Number(stdout)));

/** Kills the host and waits until the spawner has seen it go, via a child in flight. */
const killHost = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPid = yield* forkingPid;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const inFlight = yield* spawner.spawn(sh("sleep 30"));
      process.kill(hostPid, "SIGKILL");
      return { hostPid, exit: yield* Effect.exit(inFlight.exitCode) };
    }),
  );
});

describe("spawnsThroughHost", () => {
  it("hosts spawns only where Node still forks the server", () => {
    expect(SpawnHost.spawnsThroughHost("linux", "1.52.1")).toBe(true);
    expect(SpawnHost.spawnsThroughHost("linux", "1.51.0")).toBe(true);
    expect(SpawnHost.spawnsThroughHost("linux", "1.53.0")).toBe(false);
    expect(SpawnHost.spawnsThroughHost("linux", "2.0.0")).toBe(false);
    expect(SpawnHost.spawnsThroughHost("darwin", "1.52.1")).toBe(false);
    expect(SpawnHost.spawnsThroughHost("win32", "1.52.1")).toBe(false);
  });
});

describe("SpawnHost.layer", () => {
  // The server's platform layer: NodeServices with this spawner in place of Node's.
  const layerPlatform = SpawnHost.layer.pipe(Layer.provideMerge(NodeServices.layer));

  it.effect.skipIf(!SpawnHost.spawnsThroughHost("linux", process.versions.uv))(
    "forks children from a host running this checkout's CLI entry on Linux",
    () =>
      forkingPid.pipe(
        Effect.map((parent) => expect(parent).not.toBe(process.pid)),
        Effect.provide(layerPlatform),
        Effect.provideService(HostProcess.Platform, "linux"),
      ),
  );

  it.effect("spawns directly elsewhere", () =>
    forkingPid.pipe(
      Effect.map((parent) => expect(parent).toBe(process.pid)),
      Effect.provide(layerPlatform),
      Effect.provideService(HostProcess.Platform, "darwin"),
    ),
  );
});

describe("SpawnHost.layerHosted", () => {
  it.effect("forks children from the host, not from this process", () =>
    Effect.gen(function* () {
      const parent = yield* forkingPid;
      expect(parent).not.toBe(process.pid);
      expect(isAlive(parent)).toBe(true);
    }).pipe(Effect.provide(layerHosted())),
  );

  it.effect("reports what the Node spawner reports for output, exits and spawn errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spawn-host-" });
      const notExecutable = path.join(dir, "script.sh");
      yield* fs.writeFileString(notExecutable, "#!/bin/sh\necho hi\n");
      const cases = [
        sh("printf out; printf err >&2"),
        sh("printf partial; exit 3"),
        sh("kill -TERM $$"),
        sh('pwd; printf "$T3_SPAWN_HOST_TEST"', {
          cwd: dir,
          env: { T3_SPAWN_HOST_TEST: "from-env" },
          extendEnv: true,
        }),
        sh("cat", { stdin: Stream.encodeText(Stream.make("piped stdin")) }),
        ChildProcess.make("printf shell-string", [], { shell: true }),
        ChildProcess.make("t3-spawn-host-missing-binary"),
        ChildProcess.make(notExecutable),
        ChildProcess.make("/etc/passwd/not-a-directory"),
        sh("true", { cwd: path.join(dir, "missing") }),
      ];
      const observeAll = Effect.forEach(cases, observe);
      const hosted = yield* observeAll.pipe(Effect.provide(layerHosted()));
      const direct = yield* observeAll.pipe(Effect.provide(layerDirect));

      expect(hosted).toEqual(direct);
      expect(hosted[0]).toEqual({ stdout: "out", stderr: "err", code: 0 });
      expect(hosted[1]).toEqual({ stdout: "partial", stderr: "", code: 3 });
      expect(hosted[2]).toEqual({ error: "Unknown", errno: undefined });
      expect(hosted[3]).toMatchObject({ stdout: expect.stringContaining("from-env"), code: 0 });
      expect(hosted[4]).toEqual({ stdout: "piped stdin", stderr: "", code: 0 });
      expect(hosted[6]).toEqual({ error: "NotFound", errno: "ENOENT" });
      expect(hosted[7]).toEqual({ error: "PermissionDenied", errno: "EACCES" });
      expect(hosted[8]).toEqual({ defect: "ENOTDIR" });
      expect(hosted[9]).toMatchObject({ error: "NotFound" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("streams large output and stdin through the handed-over sockets", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const input = "x".repeat(3_000_000);
      const { stdout, code } = yield* run(
        sh("cat", { stdin: Stream.encodeText(Stream.make(input)) }),
      );
      expect(code).toBe(0);
      expect(stdout).toBe(input);

      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(sh("head -c 20000000 /dev/zero"));
          return yield* handle.stdout.pipe(
            Stream.runFold(
              () => 0,
              (total, chunk) => total + chunk.length,
            ),
          );
        }),
      );
      expect(bytes).toBe(20_000_000);
    }).pipe(Effect.provide(layerHosted())),
  );

  it.effect("runs many processes at once without crossing their output", () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const results = yield* Effect.forEach(
        Array.from({ length: 200 }, (_, index) => index),
        (index) =>
          runner.run({
            command: "sh",
            args: ["-c", `printf out-${index}; printf err-${index} >&2; exit ${index % 7}`],
          }),
        { concurrency: "unbounded" },
      );
      results.forEach((result, index) => {
        expect(result).toMatchObject({
          stdout: `out-${index}`,
          stderr: `err-${index}`,
          code: index % 7,
        });
      });
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(layerHosted())))),
  );

  it.effect("closes every socket it adopts once the children are done", () =>
    Effect.gen(function* () {
      const runner = yield* ProcessRunner.ProcessRunner;
      const openDescriptors = () => NodeFS.readdirSync("/dev/fd").length;
      yield* runner.run({ command: "true", args: [] });
      const before = openDescriptors();
      yield* Effect.forEach(
        Array.from({ length: 200 }),
        () => runner.run({ command: "sh", args: ["-c", "printf done"] }),
        { concurrency: 20 },
      );
      expect(openDescriptors() - before).toBeLessThan(50);
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(layerHosted())))),
  );

  it.effect("kill stops the child's whole process group", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(sh("sleep 30 & echo $!; wait"));
      const grandchild = yield* firstLine(handle.stdout);
      expect(isAlive(grandchild)).toBe(true);

      yield* handle.kill();

      expect(isAlive(grandchild)).toBe(false);
      expect(isAlive(handle.pid)).toBe(false);
      expect(Exit.isFailure(yield* Effect.exit(handle.exitCode))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layerHosted())),
  );

  it.effect("closing the scope stops a running child and its group", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { child, grandchild } = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(sh("sleep 30 & echo $!; wait"));
          return { child: Number(handle.pid), grandchild: yield* firstLine(handle.stdout) };
        }),
      );
      expect(isAlive(child)).toBe(false);
      expect(isAlive(grandchild)).toBe(false);
    }).pipe(Effect.provide(layerHosted())),
  );

  it.effect("a dead host fails its children's exit instead of hanging, then is replaced", () =>
    Effect.gen(function* () {
      const { hostPid, exit } = yield* killHost;
      expect(Exit.isFailure(exit)).toBe(true);

      const replacement = yield* forkingPid;
      expect(replacement).not.toBe(hostPid);
      expect(replacement).not.toBe(process.pid);
      expect(yield* run(sh("printf still-works"))).toEqual({
        stdout: "still-works",
        stderr: "",
        code: 0,
      });
    }).pipe(Effect.provide(layerHosted())),
  );

  it.effect("spawns directly once the host keeps dying", () =>
    Effect.gen(function* () {
      yield* killHost;
      yield* killHost;
      yield* killHost;
      expect(yield* forkingPid).toBe(process.pid);
    }).pipe(Effect.provide(layerHosted())),
  );

  it.effect("spawns directly when the host never starts", () =>
    Effect.gen(function* () {
      expect(yield* forkingPid).toBe(process.pid);
      expect(yield* run(sh("printf fallback"))).toEqual({
        stdout: "fallback",
        stderr: "",
        code: 0,
      });
    }).pipe(
      Effect.provide(layerHosted({ command: process.execPath, args: ["-e", "process.exit(1)"] })),
    ),
  );
});
