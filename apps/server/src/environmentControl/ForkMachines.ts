// @effect-diagnostics globalTimers:off - the E2B adapter waits between retries inside Promise SDK calls.
// @effect-diagnostics globalFetch:off - E2B's disk capture is an API call its SDK does not expose yet.
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
import {
  CommandExitError,
  ConnectionConfig,
  E2B,
  type Sandbox,
  SandboxError,
  type SandboxNetworkUpdate,
  ServiceBusyError,
} from "e2b";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { EnvironmentControlConfig } from "./config.ts";
import { agentEnvironmentPython } from "./guestAgentEnvironment.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";

export type WorkerForkSettings = NonNullable<
  NonNullable<EnvironmentControlConfig["provisioning"]>["workerForks"]
>;

export class ForkMachineError extends Schema.TaggedError<ForkMachineError>()("ForkMachineError", {
  step: Schema.Literals(["settings", "capture", "start", "run", "upload", "copy", "kill", "sweep"]),
  cause: Schema.Defect(),
  /** The provider could not place the copy now and asked for a retry; nothing was left running. */
  busy: Schema.optional(Schema.Boolean),
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

export type ForkUpload =
  | { readonly kind: "uploaded"; readonly missing: ReadonlyArray<string> }
  /** The chat's settings name these credentials, but the machine's secret store lacks them. */
  | { readonly kind: "no_credentials"; readonly unresolved: ReadonlyArray<string> };

export type ForkCopyBack =
  | { readonly kind: "copied" }
  | { readonly kind: "too_large"; readonly bytes: number }
  /** The chat's machine went to sleep while the job ran; it is not woken for this. */
  | { readonly kind: "asleep" };

export class ForkMachines extends Context.Service<
  ForkMachines,
  {
    /** This host's fork settings, or null when it has no cloud configuration. */
    readonly settings: Effect.Effect<WorkerForkSettings | null, ForkMachineError>;
    /** Captures the chat's machine once; every copy in its batch starts from the capture. */
    readonly capture: (sandboxId: string, tag: ForkTag) => Effect.Effect<string, ForkMachineError>;
    /** Deletes a capture once no copy of it is left. A capture already gone is fine. */
    readonly release: (captureId: string) => Effect.Effect<void, ForkMachineError>;
    /**
     * Starts one copy, which the provider removes by itself after `lifetimeMs`. The copy has no
     * network until its T3 server and every agent process it inherited are stopped, so it can
     * never act as the chat; until then it also ends by itself within minutes.
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
    /**
     * Uploads the job's logs under `<uri>logs/` and its outputs under `<uri>outputs/`, each at its
     * path as given, with the chat agent's AWS credentials; answers the outputs that did not
     * exist. Uploads nothing when those credentials are set but cannot be read on the machine.
     */
    readonly upload: (
      forkId: string,
      input: { readonly cwd: string; readonly paths: ReadonlyArray<string>; readonly uri: string },
    ) => Effect.Effect<ForkUpload, ForkMachineError>;
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
    /**
     * Removes `host`'s copies, then its captures, of every batch `remove` picks; answers how many
     * of each it removed and how many it could not. Every item is tried; what fails is left for
     * the next sweep. A batch's end sweeps it, which catches a copy whose start answer was lost.
     */
    readonly sweep: (
      host: string,
      remove: (batchId: string) => boolean,
    ) => Effect.Effect<
      { readonly forks: number; readonly captures: number; readonly failed: number },
      ForkMachineError
    >;
  }
>()("t3/environmentControl/ForkMachines") {}

const COPY_PURPOSE = "t3-worker-fork";
const STATE = "/tmp/t3-fork";
const TMP_STASH = "/home/user/.t3-fork-tmp";
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const encodeSpec = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const python = (script: string, spec?: unknown) =>
  `exec python3 -c ${shellQuote(script)}${spec === undefined ? "" : ` ${shellQuote(encodeSpec(spec))}`}`;

/** A copy that never gets quieted, as when its start answer is lost, ends by itself by then. */
const QUIET_WINDOW_MS = 10 * 60_000;
const IN_USE_RETRIES = 5;

/** Each host's captures share this name prefix, then the batch id. */
const capturePrefix = (host: string) =>
  `${COPY_PURPOSE}-${host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 20)}-`;

/** The batch a snapshot name belongs to, for `team/name:tag` or a bare name, or null. */
export const captureBatch = (host: string, snapshotName: string): string | null => {
  const name =
    snapshotName
      .replace(/:[^/]*$/, "")
      .split("/")
      .at(-1) ?? "";
  const prefix = capturePrefix(host);
  return name.startsWith(prefix) && name.length > prefix.length ? name.slice(prefix.length) : null;
};

/**
 * Makes a fresh copy run nothing but the job. A copy from a full capture is the chat's whole
 * machine, memory included: its T3 server and agents, running. Left running, the copy's server
 * would answer as the chat and its agents would keep working and billing the provider. So before
 * any job runs, the copy records the environment the chat's agent sees (see
 * guestAgentEnvironment.ts) and kills every process its user owns. The server runs as that user,
 * and the check below refuses a copy where it survived. A copy booted from a disk capture has
 * nothing to kill, and this only confirms it. Either way the copy starts with no network and gets
 * it back only after this, so nothing it inherited can reach the host, GitHub or a provider.
 */
const QUIET = String.raw`
import json, os, pathlib, shutil, signal, time
${agentEnvironmentPython}
env, server, home, settings = agent_env(pathlib.Path('/home/user/.t3-provision'))
state = pathlib.Path('${STATE}')
(state / 'out').mkdir(parents=True, exist_ok=True)
os.umask(0o077)
(state / 'env.json').write_text(json.dumps(env))
(state / 'unresolved.json').write_text(json.dumps(unresolved_env(home, settings)))
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
# A copy booted from disk starts with an empty /tmp; put back what the chat had there.
stash = pathlib.Path('${TMP_STASH}')
for batch in stash.glob('*'):
    for entry in batch.iterdir():
        target = pathlib.Path('/tmp') / entry.name
        if not target.exists() and not target.is_symlink():
            os.rename(entry, target)
shutil.rmtree(stash, ignore_errors=True)
`;

/**
 * Keeps the chat's /tmp for a copy booted from disk, whose boot empties /tmp. Run on the chat's
 * machine just before its capture: it hardlinks every file under /tmp into the stash, which sits
 * on the same disk and so takes no space, and the capture carries it. The stash is removed from
 * the chat's machine right after the capture, and any older one first. Files the chat's user
 * cannot link, such as other users', are left out and counted.
 */
const STASH = String.raw`
import json, os, shutil, sys
target = os.path.join('${TMP_STASH}', json.loads(sys.argv[1]))
shutil.rmtree('${TMP_STASH}', ignore_errors=True)
skipped = 0
for path, directories, files in os.walk('/tmp'):
    relative = os.path.relpath(path, '/tmp')
    if relative.split(os.sep)[0].startswith('systemd-private-'):
        directories[:] = []
        continue
    destination = os.path.normpath(os.path.join(target, relative))
    os.makedirs(destination, exist_ok=True)
    try:
        shutil.copymode(path, destination)
    except OSError:
        pass
    for name in files + [name for name in directories if os.path.islink(os.path.join(path, name))]:
        source = os.path.join(path, name)
        try:
            if os.path.islink(source):
                os.symlink(os.readlink(source), os.path.join(destination, name))
            else:
                os.link(source, os.path.join(destination, name))
        except OSError:
            skipped += 1
    directories[:] = [name for name in directories if not os.path.islink(os.path.join(path, name))]
print(json.dumps({'skipped': skipped}))
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
unresolved = [name for name in json.load(open('${STATE}/unresolved.json')) if name.startswith('AWS_')]
if unresolved:
    print(json.dumps({'kind': 'no_credentials', 'unresolved': unresolved}))
    sys.exit(0)
aws = shutil.which('aws', path=env.get('PATH')) or '/home/user/.local/bin/aws'
def copy(source, key, recursive):
    subprocess.run([aws, 's3', 'cp', '--only-show-errors', *(['--recursive'] if recursive else []), source, spec['uri'] + key], env=env, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, timeout=3600)
copy('${STATE}/out/stdout.log', 'logs/stdout.log', False)
copy('${STATE}/out/stderr.log', 'logs/stderr.log', False)
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
print(json.dumps({'kind': 'uploaded', 'missing': missing}))
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
const decodeUpload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("uploaded"), missing: Schema.Array(Schema.String) }),
      Schema.Struct({
        kind: Schema.Literal("no_credentials"),
        unresolved: Schema.Array(Schema.String),
      }),
    ]),
  ),
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
/** E2B refuses to delete a snapshot while a sandbox made from it exists; a just-killed one lingers. */
async function deleteSnapshot(e2b: E2B, snapshotId: string) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await e2b.Sandbox.deleteSnapshot(snapshotId);
      return;
    } catch (error) {
      const inUse = error instanceof SandboxError && /sandboxes using it/.test(error.message);
      if (!inUse || attempt >= IN_USE_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
}

const decodeDiskCapture = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ snapshotID: Schema.String }),
    Schema.Struct({ error_code: Schema.String }),
  ]),
);

/**
 * Captures only a sandbox's disk, so copies boot fresh from it rather than resuming its memory.
 * Copies need nothing from memory: everything they would inherit there is killed anyway. And a
 * memory image saved while the box was pinned at full CPU can be impossible to place, which
 * fails every copy. E2B offers this per team (`memory: false`, which its SDK does not expose yet);
 * answers null where the team does not have it, and the caller takes a full snapshot.
 */
async function captureDisk(apiKey: string, sandboxId: string, name: string, signal: AbortSignal) {
  const response = await fetch(
    `${new ConnectionConfig({ apiKey }).apiUrl}/sandboxes/${encodeURIComponent(sandboxId)}/snapshots`,
    {
      method: "POST",
      headers: { "X-API-Key": apiKey, "content-type": "application/json" },
      body: encodeSpec({ name, memory: false }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    },
  );
  const body = decodeDiskCapture(await response.json());
  if (response.ok && "snapshotID" in body) return body.snapshotID;
  if (
    response.status === 400 &&
    "error_code" in body &&
    body.error_code === "snapshot_filesystem_only_disabled"
  )
    return null;
  throw new Error(`E2B refused a disk capture with status ${response.status}`);
}

/** Reads a file from a copy, giving up past `maxBytes` whatever the copy claims its size is. */
async function readBounded(sandbox: Sandbox, path: string, maxBytes: number) {
  const stream = await sandbox.files.read(path, { format: "stream", requestTimeoutMs: 600_000 });
  const reader = stream.getReader();
  const chunks: Array<Uint8Array> = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { kind: "read" as const, data: new Blob(chunks) };
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      return { kind: "too_large" as const, bytes };
    }
    chunks.push(value);
  }
}

/** Copies E2B sandboxes with the host's own E2B key; the chat's agent never holds it. */
export const layerE2b = Layer.effect(
  ForkMachines,
  Effect.gen(function* () {
    const control = yield* EnvironmentControl.EnvironmentControl;
    const running = new Map<string, Sandbox>();
    // The chat machine's egress rules per capture, restored on each copy once it is quiet.
    const networks = new Map<string, SandboxNetworkUpdate>();
    const client = (step: ForkMachineError["step"]) =>
      control.controlConfig.pipe(
        Effect.mapError((cause) => new ForkMachineError({ step, cause })),
        Effect.flatMap((config) =>
          config === null
            ? Effect.fail(
                new ForkMachineError({ step, cause: new Error("No cloud configuration") }),
              )
            : Effect.succeed({
                e2b: new E2B({ apiKey: config.e2bApiKey }),
                apiKey: config.e2bApiKey,
              }),
        ),
      );
    const attempt = <A>(
      step: ForkMachineError["step"],
      body: (e2b: E2B, signal: AbortSignal, apiKey: string) => Promise<A>,
    ) =>
      client(step).pipe(
        Effect.flatMap(({ e2b, apiKey }) =>
          Effect.tryPromise({
            try: (signal) => body(e2b, signal, apiKey),
            catch: (cause) => new ForkMachineError({ step, cause }),
          }),
        ),
      );
    const copyOf = (step: ForkMachineError["step"], forkId: string) =>
      attempt(step, async (e2b) => running.get(forkId) ?? (await e2b.Sandbox.connect(forkId)));

    return ForkMachines.of({
      settings: control.controlConfig.pipe(
        Effect.map((config) => (config === null ? null : (config.provisioning?.workerForks ?? {}))),
        Effect.mapError((cause) => new ForkMachineError({ step: "settings", cause })),
      ),

      capture: (sandboxId, tag) =>
        attempt("capture", async (e2b, signal, apiKey) => {
          const { network, state } = await e2b.Sandbox.getInfo(sandboxId, { signal });
          if (state !== "running") throw new Error("The chat's machine is not running");
          const name = `${capturePrefix(tag.host)}${tag.batchId}`;
          // Never extends the chat's own timeout: a running sandbox keeps the longer one.
          const source = await e2b.Sandbox.connect(sandboxId, { timeoutMs: 1_000 });
          // Without its /tmp a disk capture would lose the chat's working data, so a chat whose
          // /tmp cannot be stashed gets a full capture, which keeps /tmp with the rest of memory.
          const stashed = await exec(source, python(STASH, tag.batchId), 120_000).then(
            () => true,
            () => false,
          );
          let snapshotId: string;
          try {
            snapshotId =
              (stashed ? await captureDisk(apiKey, sandboxId, name, signal) : null) ??
              (
                await e2b.Sandbox.createSnapshot(sandboxId, {
                  name,
                  requestTimeoutMs: 300_000,
                  signal,
                })
              ).snapshotId;
          } finally {
            await exec(source, `rm -rf ${TMP_STASH}`, 120_000).catch(() => undefined);
          }
          networks.set(snapshotId, {
            ...(network?.allowOut ? { allowOut: network.allowOut } : {}),
            ...(network?.denyOut ? { denyOut: network.denyOut } : {}),
          });
          return snapshotId;
        }),

      release: (captureId) =>
        attempt("capture", async (e2b) => {
          networks.delete(captureId);
          await deleteSnapshot(e2b, captureId);
        }),

      start: (captureId, tag, lifetimeMs) =>
        attempt("start", async (e2b, signal) => {
          const sandbox = await e2b.Sandbox.create(captureId, {
            signal,
            requestTimeoutMs: 300_000,
            timeoutMs: Math.min(QUIET_WINDOW_MS, lifetimeMs),
            allowInternetAccess: false,
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
            await e2b.Sandbox.updateNetwork(sandbox.sandboxId, networks.get(captureId) ?? {});
            await e2b.Sandbox.setTimeout(sandbox.sandboxId, lifetimeMs);
          } catch (error) {
            await e2b.Sandbox.kill(sandbox.sandboxId).catch(() => undefined);
            throw error;
          }
          running.set(sandbox.sandboxId, sandbox);
          return sandbox.sandboxId;
        }).pipe(
          // E2B answers a placement it could not make with a 5xx that asks for a retry. A copy that
          // was created is killed above before the error leaves, so a retry never leaks one.
          Effect.mapError((error) =>
            error.cause instanceof ServiceBusyError ||
            (error.cause instanceof SandboxError && (error.cause.statusCode ?? 0) >= 500)
              ? new ForkMachineError({ step: error.step, cause: error.cause, busy: true })
              : error,
          ),
        ),

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
              try: async () => decodeUpload(await exec(sandbox, python(UPLOAD, input), 3_700_000)),
              catch: (cause) => new ForkMachineError({ step: "upload", cause }),
            }),
          ),
        ),

      copyBack: (forkId, input) =>
        copyOf("copy", forkId).pipe(
          Effect.flatMap((fork) =>
            attempt("copy", async (e2b) => {
              await exec(fork, python(PACK, { cwd: input.cwd, paths: input.paths }), 600_000);
              const archive = await readBounded(fork, `${STATE}/copy.tgz`, input.maxBytes);
              if (archive.kind === "too_large") return archive;
              if ((await e2b.Sandbox.getInfo(input.sourceSandboxId)).state !== "running")
                return { kind: "asleep" as const };
              const source = await e2b.Sandbox.connect(input.sourceSandboxId);
              const target = shellQuote(input.destination);
              await source.files.write(`${input.destination}.tgz`, archive.data, {
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
        attempt("kill", async (e2b) => {
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

      sweep: (host, remove) =>
        attempt("sweep", async (e2b) => {
          // Everything is listed before anything is removed, so removing never shifts a page.
          const copies: Array<string> = [];
          const listed = e2b.Sandbox.list({
            query: { metadata: { purpose: COPY_PURPOSE, host }, state: ["running", "paused"] },
            limit: 100,
          });
          while (listed.hasNext)
            for (const copy of await listed.nextItems())
              if (remove(copy.metadata.batch ?? "")) copies.push(copy.sandboxId);
          const captures: Array<string> = [];
          const snapshots = e2b.Sandbox.listSnapshots({ limit: 100 });
          while (snapshots.hasNext)
            for (const snapshot of await snapshots.nextItems()) {
              const batchId = snapshot.names
                .map((name) => captureBatch(host, name))
                .find((batch) => batch !== null);
              if (batchId !== undefined && batchId !== null && remove(batchId))
                captures.push(snapshot.snapshotId);
            }
          // Copies go first: a capture cannot be deleted while a copy of it exists.
          const results = [
            ...(await Promise.allSettled(
              copies.map((copyId) => {
                running.delete(copyId);
                return e2b.Sandbox.kill(copyId);
              }),
            )),
            ...(await Promise.allSettled(
              captures.map((captureId) => {
                networks.delete(captureId);
                return deleteSnapshot(e2b, captureId);
              }),
            )),
          ];
          return {
            forks: copies.length,
            captures: captures.length,
            failed: results.filter((result) => result.status === "rejected").length,
          };
        }),
    });
  }),
);
