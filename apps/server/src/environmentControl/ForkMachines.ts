/**
 * ForkMachines - the cloud provider side of t3_fork_run: copies of a chat's machine.
 *
 * WorkerForks decides what runs where and for how long; this port does each step on the
 * provider. `layerE2b` copies an E2B sandbox by snapshotting it once per batch and starting
 * every copy from that snapshot, so all of a batch's jobs see the chat's machine as it was when
 * the batch started, and each copy carries this host's tags for the sweep.
 *
 * @module ForkMachines
 */
import { CommandExitError, E2B, type Sandbox } from "e2b";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { EnvironmentControlConfig } from "./config.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";

export type WorkerForkSettings = NonNullable<
  NonNullable<EnvironmentControlConfig["provisioning"]>["workerForks"]
>;

export class ForkMachineError extends Schema.TaggedError<ForkMachineError>()("ForkMachineError", {
  step: Schema.Literals(["capture", "start", "run", "upload", "copy", "sweep"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `A copy of the chat's machine failed at its ${this.step} step.`;
  }
}

/** Who a copy belongs to, recorded on the provider so a sweep finds it after a crash. */
export interface ForkTag {
  /** This host, so a sweep never touches another host's copies on a shared account. */
  readonly host: string;
  readonly batchId: string;
  readonly leaseId: string;
}

export interface ForkJobExit {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
}

export type ForkCopyBack =
  | { readonly kind: "copied" }
  | { readonly kind: "too_large"; readonly bytes: number };

export class ForkMachines extends Context.Service<
  ForkMachines,
  {
    /** This host's fork settings, or null when it has no cloud configuration. */
    readonly settings: Effect.Effect<WorkerForkSettings | null, ForkMachineError>;
    /** Captures the chat's machine once; every copy in its batch starts from the capture. */
    readonly capture: (sandboxId: string, tag: ForkTag) => Effect.Effect<string, ForkMachineError>;
    /** Deletes a capture. Never fails: a capture left behind is the sweep's. */
    readonly release: (captureId: string) => Effect.Effect<void>;
    /**
     * Starts one copy, which the provider removes by itself after `lifetimeMs`. Before it
     * returns, the copy's T3 server and every agent process it inherited are stopped.
     */
    readonly start: (
      captureId: string,
      tag: ForkTag,
      lifetimeMs: number,
    ) => Effect.Effect<string, ForkMachineError>;
    /** Runs a job to its end or its timeout; the job's own failure is its exit code. */
    readonly run: (
      forkId: string,
      job: { readonly command: string; readonly cwd: string; readonly timeoutMs: number },
    ) => Effect.Effect<ForkJobExit, ForkMachineError>;
    /** Uploads the job's logs and outputs under `uri`; answers the outputs that did not exist. */
    readonly upload: (
      forkId: string,
      input: { readonly cwd: string; readonly paths: ReadonlyArray<string>; readonly uri: string },
    ) => Effect.Effect<{ readonly missing: ReadonlyArray<string> }, ForkMachineError>;
    /** Copies the job's outputs into the chat's machine at `destination`, within `maxBytes`. */
    readonly copyBack: (
      forkId: string,
      input: {
        readonly sourceSandboxId: string;
        readonly cwd: string;
        readonly paths: ReadonlyArray<string>;
        readonly destination: string;
        readonly maxBytes: number;
      },
    ) => Effect.Effect<ForkCopyBack, ForkMachineError>;
    /** Removes a copy. Never fails, and a copy already gone is fine. */
    readonly kill: (forkId: string) => Effect.Effect<void>;
    /** Removes every copy and capture tagged with `host`; answers how many of each. */
    readonly sweep: (
      host: string,
    ) => Effect.Effect<{ readonly forks: number; readonly captures: number }, ForkMachineError>;
  }
>()("t3/environmentControl/ForkMachines") {}

const COPY_PURPOSE = "t3-worker-fork";
const STATE = "/tmp/t3-fork";
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const python = (script: string, spec?: unknown) =>
  `exec python3 -c ${shellQuote(script)}${spec === undefined ? "" : ` ${shellQuote(JSON.stringify(spec))}`}`;

const captureName = (host: string, batchId?: string) =>
  `${COPY_PURPOSE}-${host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 20)}-${batchId ?? ""}`;

/**
 * Makes a fresh copy run nothing but the job. A copy is the chat's whole machine, memory
 * included: its T3 server, its agents, and the provider credentials they use. Left running, the
 * copy's server would answer as the chat and its agents would keep working and billing the
 * provider. So before any job runs, the copy records the environment the chat's agent sees (the
 * T3 server's, plus each provider instance's variables, such as the AWS keys outputs upload with)
 * and then kills every process its user owns. The server runs as that user, and the check below
 * refuses a copy where it survived.
 */
const QUIET = String.raw`
import json, os, pathlib, signal, time
root = pathlib.Path('/home/user/.t3-provision')
server = None
env = dict(os.environ)
try:
    server = json.loads((root / 'server.json').read_text())['pid']
    raw = pathlib.Path('/proc/%d/environ' % server).read_bytes().decode(errors='replace')
    env = dict(item.split('=', 1) for item in raw.split('\0') if '=' in item)
except (OSError, ValueError, KeyError):
    pass
home = pathlib.Path(env.get('T3CODE_HOME', str(root / 'home' / '.t3')))
for path in (home / 'userdata' / 'settings.json', home / 'settings.json'):
    try:
        settings = json.loads(path.read_text())
    except (OSError, ValueError):
        continue
    for instance in (settings.get('providerInstances') or {}).values():
        for variable in (instance or {}).get('environment') or []:
            if isinstance(variable, dict) and isinstance(variable.get('name'), str) and isinstance(variable.get('value'), str):
                env[variable['name']] = variable['value']
    break
state = pathlib.Path('${STATE}')
(state / 'out').mkdir(parents=True, exist_ok=True)
os.umask(0o077)
(state / 'env.json').write_text(json.dumps(env))
def alive(pid):
    try:
        return '\nState:\tZ' not in '\n' + pathlib.Path('/proc/%d/status' % pid).read_text()
    except OSError:
        return False
# SIGKILL lands asynchronously, so look again until the server is gone.
deadline = time.monotonic() + 10
while True:
    try:
        os.kill(-1, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if server is None or not alive(server):
        break
    if time.monotonic() > deadline:
        raise SystemExit('the copied T3 server is still running')
    time.sleep(0.05)
`;

const RUN = String.raw`
import json, os, subprocess, sys, time
spec = json.loads(sys.argv[1])
env = json.load(open('${STATE}/env.json'))
out = '${STATE}/out/'
with open(out + 'stdout.log', 'wb') as stdout, open(out + 'stderr.log', 'wb') as stderr:
    try:
        child = subprocess.Popen(['bash', '-lc', spec['command']], cwd=spec['cwd'], env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
    except OSError as error:
        stderr.write(('Could not start the job in %s: %s\n' % (spec['cwd'], error)).encode())
        child = None
    timed_out = False
    if child is None:
        code = 127
    else:
        try:
            code = child.wait(timeout=spec['timeoutMs'] / 1000)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, 9)
            code = child.wait()
            timed_out = True
def tail(name):
    with open(out + name, 'rb') as log:
        log.seek(0, 2)
        log.seek(max(0, log.tell() - 4000))
        return log.read().decode(errors='replace')
print(json.dumps({'exitCode': code, 'timedOut': timed_out, 'stdoutTail': tail('stdout.log'), 'stderrTail': tail('stderr.log')}))
`;

const UPLOAD = String.raw`
import json, os, shutil, subprocess, sys
spec = json.loads(sys.argv[1])
env = json.load(open('${STATE}/env.json'))
aws = shutil.which('aws', path=env.get('PATH')) or '/home/user/.local/bin/aws'
def copy(source, key, recursive):
    subprocess.run([aws, 's3', 'cp', '--only-show-errors', *(['--recursive'] if recursive else []), source, spec['uri'] + key], env=env, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=3600)
copy('${STATE}/out/stdout.log', 'stdout.log', False)
copy('${STATE}/out/stderr.log', 'stderr.log', False)
missing = []
for path in spec['paths']:
    full = os.path.join(spec['cwd'], path)
    key = 'outputs/' + path.lstrip('/')
    if os.path.isdir(full):
        copy(full, key.rstrip('/') + '/', True)
    elif os.path.exists(full):
        copy(full, key, False)
    else:
        missing.append(path)
print(json.dumps({'missing': missing}))
`;

const PACK = String.raw`
import json, os, sys, tarfile
spec = json.loads(sys.argv[1])
with tarfile.open('${STATE}/copy.tgz', 'w:gz') as archive:
    for path in spec['paths']:
        full = os.path.join(spec['cwd'], path)
        if os.path.exists(full):
            archive.add(full, arcname=path.lstrip('/'))
print(os.path.getsize('${STATE}/copy.tgz'))
`;

const decodeExit = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      exitCode: Schema.Int,
      timedOut: Schema.Boolean,
      stdoutTail: Schema.String,
      stderrTail: Schema.String,
    }),
  ),
);
const decodeMissing = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ missing: Schema.Array(Schema.String) })),
);

/** Runs a step's command, with a non-zero exit as the step's failure. */
async function exec(sandbox: Sandbox, command: string, timeoutMs: number) {
  try {
    return (await sandbox.commands.run(command, { timeoutMs, requestTimeoutMs: 60_000 })).stdout;
  } catch (error) {
    if (error instanceof CommandExitError)
      throw new Error(`exit ${error.exitCode}: ${error.stderr.slice(-2000)}`, { cause: error });
    throw error;
  }
}

/** Copies E2B sandboxes with the host's own E2B key; the chat's agent never holds it. */
export const layerE2b = Layer.effect(
  ForkMachines,
  Effect.gen(function* () {
    const control = yield* EnvironmentControl.EnvironmentControl;
    const running = new Map<string, Sandbox>();
    const client = (step: ForkMachineError["step"]) =>
      control.controlConfig.pipe(
        Effect.mapError((cause) => new ForkMachineError({ step, cause })),
        Effect.flatMap((config) =>
          config === null
            ? Effect.fail(
                new ForkMachineError({ step, cause: new Error("No cloud configuration") }),
              )
            : Effect.succeed(new E2B({ apiKey: config.e2bApiKey })),
        ),
      );
    const attempt = <A>(
      step: ForkMachineError["step"],
      body: (e2b: E2B, signal: AbortSignal) => Promise<A>,
    ) =>
      client(step).pipe(
        Effect.flatMap((e2b) =>
          Effect.tryPromise({
            try: (signal) => body(e2b, signal),
            catch: (cause) => new ForkMachineError({ step, cause }),
          }),
        ),
      );
    const copyOf = (step: ForkMachineError["step"], forkId: string) =>
      attempt(step, async (e2b) => running.get(forkId) ?? (await e2b.Sandbox.connect(forkId)));

    return ForkMachines.of({
      settings: control.controlConfig.pipe(
        Effect.map((config) => (config === null ? null : (config.provisioning?.workerForks ?? {}))),
        Effect.mapError((cause) => new ForkMachineError({ step: "start", cause })),
      ),

      capture: (sandboxId, tag) =>
        attempt(
          "capture",
          async (e2b, signal) =>
            (
              await e2b.Sandbox.createSnapshot(sandboxId, {
                name: captureName(tag.host, tag.batchId),
                signal,
              })
            ).snapshotId,
        ),

      release: (captureId) =>
        attempt("capture", (e2b) => e2b.Sandbox.deleteSnapshot(captureId)).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning("a worker fork capture could not be deleted", {
              captureId,
              cause: error.cause,
            }),
          ),
        ),

      start: (captureId, tag, lifetimeMs) =>
        attempt("start", async (e2b, signal) => {
          const sandbox = await e2b.Sandbox.create(captureId, {
            signal,
            timeoutMs: lifetimeMs,
            // Not paused like a chat's machine: a copy the host lost track of ends by itself.
            lifecycle: { onTimeout: "kill" },
            metadata: {
              purpose: COPY_PURPOSE,
              host: tag.host,
              batch: tag.batchId,
              lease: tag.leaseId,
            },
          });
          try {
            await exec(sandbox, python(QUIET), 60_000);
          } catch (error) {
            await e2b.Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
            throw error;
          }
          running.set(sandbox.sandboxId, sandbox);
          return sandbox.sandboxId;
        }),

      run: (forkId, job) =>
        copyOf("run", forkId).pipe(
          Effect.flatMap((sandbox) =>
            Effect.tryPromise({
              try: async () =>
                decodeExit(await exec(sandbox, python(RUN, job), job.timeoutMs + 60_000)),
              catch: (cause) => new ForkMachineError({ step: "run", cause }),
            }),
          ),
        ),

      upload: (forkId, input) =>
        copyOf("upload", forkId).pipe(
          Effect.flatMap((sandbox) =>
            Effect.tryPromise({
              try: async () => decodeMissing(await exec(sandbox, python(UPLOAD, input), 3_700_000)),
              catch: (cause) => new ForkMachineError({ step: "upload", cause }),
            }),
          ),
        ),

      copyBack: (forkId, input) =>
        copyOf("copy", forkId).pipe(
          Effect.flatMap((fork) =>
            attempt("copy", async (e2b) => {
              const bytes = Number(
                (
                  await exec(fork, python(PACK, { cwd: input.cwd, paths: input.paths }), 600_000)
                ).trim(),
              );
              if (!(bytes <= input.maxBytes)) return { kind: "too_large" as const, bytes };
              const archive = await fork.files.read(`${STATE}/copy.tgz`, {
                format: "bytes",
                requestTimeoutMs: 600_000,
              });
              const source = await e2b.Sandbox.connect(input.sourceSandboxId);
              const target = shellQuote(input.destination);
              await source.files.write(`${input.destination}.tgz`, new Blob([archive]), {
                requestTimeoutMs: 600_000,
              });
              await exec(
                source,
                `mkdir -p ${target} && tar -xzf ${target}.tgz -C ${target} && rm -f ${target}.tgz`,
                600_000,
              );
              return { kind: "copied" as const };
            }),
          ),
        ),

      // E2B answers false for a sandbox already gone.
      kill: (forkId) =>
        attempt("start", async (e2b) => {
          running.delete(forkId);
          await e2b.Sandbox.kill(forkId);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("a worker fork could not be removed; it ends at its timeout", {
              forkId,
              cause: error.cause,
            }),
          ),
        ),

      sweep: (host) =>
        attempt("sweep", async (e2b) => {
          let forks = 0;
          const copies = e2b.Sandbox.list({
            query: { metadata: { purpose: COPY_PURPOSE, host }, state: ["running", "paused"] },
            limit: 100,
          });
          while (copies.hasNext) {
            for (const copy of await copies.nextItems()) {
              await e2b.Sandbox.kill(copy.sandboxId);
              forks += 1;
            }
          }
          let captures = 0;
          const prefix = captureName(host);
          const snapshots = e2b.Sandbox.listSnapshots({ limit: 100 });
          while (snapshots.hasNext) {
            for (const snapshot of await snapshots.nextItems()) {
              if (!snapshot.names.some((name) => name.split("/").at(-1)?.startsWith(prefix)))
                continue;
              await e2b.Sandbox.deleteSnapshot(snapshot.snapshotId);
              captures += 1;
            }
          }
          return { forks, captures };
        }),
    });
  }),
);
