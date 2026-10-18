// @effect-diagnostics globalTimers:off - the E2B adapter waits between retries inside Promise SDK calls.
// @effect-diagnostics globalFetch:off - E2B's disk capture is an API call its SDK does not expose yet.
// @effect-diagnostics nodeBuiltinImport:off - a Modal copy's outputs pass through a scratch file on the host.
/**
 * ForkMachines - the cloud provider side of t3_fork_run: copies of a chat's machine.
 *
 * WorkerForks decides what runs where and for how long; this port does each step on the
 * provider. `layer` copies a chat's machine on its own provider, E2B or Modal, by capturing it
 * once per batch and starting every copy from that capture, so all of a batch's jobs see the
 * chat's machine as it was when the batch started, and each copy carries this host's tags for
 * the sweep.
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
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ResourceExhaustedError } from "modal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { EnvironmentControlConfig } from "./config.ts";
import { agentEnvironmentPython } from "./guestAgentEnvironment.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";
import { MODAL_GUEST_ENV, type ModalBoxes, type ModalCopySpec } from "./ModalRuntime.ts";
import { serviceCommands } from "./ProvisionPreparation.ts";

export type WorkerForkSettings = NonNullable<
  NonNullable<EnvironmentControlConfig["provisioning"]>["workerForks"]
>;

export interface ForkSettings {
  readonly limits: WorkerForkSettings;
  /** The commands that start the chat's repository's services in a copy, before its job. */
  readonly services: ReadonlyArray<string>;
}

export class ForkMachineError extends Schema.TaggedError<ForkMachineError>()("ForkMachineError", {
  step: Schema.Literals([
    "settings",
    "capture",
    "start",
    "run",
    "upload",
    "copy",
    "kill",
    "sweep",
    "count",
  ]),
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
    /** This host's fork settings for a chat of `repository`, or null with no cloud configuration. */
    readonly settings: (
      repository: string | null,
    ) => Effect.Effect<ForkSettings | null, ForkMachineError>;
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
    /**
     * How many sandboxes other than `host`'s copies are running on the account copies of
     * `captureId` start on, or null where copies share no limit with chats (Modal).
     */
    readonly othersRunning: (
      captureId: string,
      host: string,
    ) => Effect.Effect<number | null, ForkMachineError>;
    /**
     * Runs `services.commands` in `services.cwd`, then the job, to its end or its timeout, which
     * covers both. The job's own failure, or a service command's, is its exit code.
     */
    readonly run: (
      forkId: string,
      job: {
        readonly command: string;
        readonly cwd: string;
        readonly timeoutMs: number;
        readonly services: { readonly commands: ReadonlyArray<string>; readonly cwd: string };
      },
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

/** A copy gives its repository's service commands this long, at most, before its job. */
const SERVICES_SECONDS = 600;

/**
 * Runs a job in a copy whose state is under `state`. The copy booted with none of the chat's
 * processes, so it first runs the repository's service commands to their end, in its checkout,
 * into the job's own logs. A command that fails or outlasts its time is the job's result and the
 * job does not run: a test run against services that never started fails for the wrong reason.
 */
export const forkRunScript = (state: string) => String.raw`
import json, os, subprocess, sys, time
spec = json.loads(sys.argv[1])
env = json.load(open('${state}/env.json'))
out = '${state}/out/'
deadline = time.monotonic() + spec['timeoutMs'] / 1000
def run(command, cwd, seconds):
    try:
        child = subprocess.Popen(['bash', '-lc', command], cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
    except OSError as error:
        stderr.write(('Could not start %s in %s: %s\n' % (command, cwd, error)).encode())
        return 127
    try:
        return child.wait(timeout=max(0, seconds))
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, 9)
        child.wait()
        return None
with open(out + 'stdout.log', 'wb', buffering=0) as stdout, open(out + 'stderr.log', 'wb', buffering=0) as stderr:
    code, timed_out = 0, False
    for command in spec['services']['commands']:
        stderr.write(('[t3] Starting this machine\'s services: %s\n' % command).encode())
        code = run(command, spec['services']['cwd'], min(${SERVICES_SECONDS}, deadline - time.monotonic()))
        if code != 0:
            stderr.write(('[t3] It %s, so the job did not run.\n' % ('did not finish in time' if code is None else 'exited %d' % code)).encode())
            code = 124 if code is None else code
            break
    if code == 0:
        code = run(spec['command'], spec['cwd'], deadline - time.monotonic())
        timed_out = code is None
        if timed_out:
            code = -9
def tail(name):
    with open(out + name, 'rb') as log:
        log.seek(0, 2)
        log.seek(max(0, log.tell() - 4000))
        return log.read().decode(errors='replace')
print(json.dumps({'exitCode': code, 'timedOut': timed_out, 'stdoutTail': tail('stdout.log'), 'stderrTail': tail('stderr.log')}))
`;

const RUN = forkRunScript(STATE);

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

/**
 * E2B could not take a new sandbox for now and nothing was created: no capacity to place it (5xx),
 * or the account at its running-sandbox limit or its request rate (429).
 */
export const e2bBusy = (cause: unknown) =>
  cause instanceof ServiceBusyError ||
  (cause instanceof SandboxError && (cause.statusCode === 429 || (cause.statusCode ?? 0) >= 500));

/** Running sandboxes on the account, from their metadata, that are not `host`'s copies. */
export const othersOf = (host: string, running: ReadonlyArray<Record<string, string>>) =>
  running.filter((metadata) => metadata.purpose !== COPY_PURPOSE || metadata.host !== host).length;

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

/**
 * Records, in a copy booted from a Modal chat's disk, the environment the chat's agent sees. The
 * copy booted with none of the chat's processes and Modal cannot run one from a disk image, so
 * unlike an E2B copy it has nothing to stop. Modal copies run as root, as Modal chats do, so the
 * E2B copy's kill of every process its user owns would end the copy itself.
 */
const RECORD_ENV = String.raw`
import json, os, pathlib
${agentEnvironmentPython}
env, _server, home, settings = agent_env(pathlib.Path('/home/user/.t3-provision'))
state = pathlib.Path('${STATE}')
(state / 'out').mkdir(parents=True, exist_ok=True)
os.umask(0o077)
(state / 'env.json').write_text(json.dumps(env))
(state / 'unresolved.json').write_text(json.dumps(unresolved_env(home, settings)))
`;

/** A Modal capture outlives any batch, so one this host lost track of expires by itself. */
const MODAL_CAPTURE_TTL_MS = 26 * 3_600_000;

/**
 * Copies Modal sandboxes: a capture is a filesystem snapshot of the chat's box, which keeps
 * running through it, and a copy is a plain sandbox booted from it with the chat's sizing and
 * egress. Captures and copies are known by the ids this host made, so a sweep after a restart
 * finds copies by their tags and leaves captures to expire.
 */
const modalMachines = Effect.gen(function* () {
  const control = yield* EnvironmentControl.EnvironmentControl;
  const captures = new Map<
    string,
    {
      readonly batchId: string;
      readonly copy: Omit<ModalCopySpec, "imageId" | "timeoutMs" | "tags">;
    }
  >();
  const copies = new Set<string>();
  const attempt = <A>(
    step: ForkMachineError["step"],
    body: (modal: {
      readonly boxes: ModalBoxes;
      readonly app: string;
      readonly environment?: string;
    }) => Promise<A>,
  ) =>
    control.modalBoxes.pipe(
      Effect.mapError((cause) => new ForkMachineError({ step, cause })),
      Effect.flatMap((modal) =>
        modal === null
          ? Effect.fail(new ForkMachineError({ step, cause: new Error("Modal is not configured") }))
          : Effect.tryPromise({
              try: () => body(modal),
              catch: (cause) =>
                new ForkMachineError({
                  step,
                  cause,
                  ...(cause instanceof ResourceExhaustedError ? { busy: true } : {}),
                }),
            }),
      ),
    );
  /** Runs a step's command in a copy as Modal chats run theirs, with a non-zero exit as its failure. */
  const exec = async (boxes: ModalBoxes, forkId: string, command: string, timeoutMs: number) => {
    const result = await boxes.exec(forkId, [...MODAL_GUEST_ENV, "sh", "-c", command], {
      timeoutMs,
    });
    if (result.exitCode !== 0)
      throw new Error(`exit ${result.exitCode}: ${result.stderr.slice(-2000)}`);
    return result.stdout;
  };
  return {
    owns: (id: string) => captures.has(id) || copies.has(id),
    capture: (sandboxId: string, tag: ForkTag) =>
      control.modalForkSource(sandboxId).pipe(
        Effect.mapError((cause) => new ForkMachineError({ step: "capture", cause })),
        Effect.flatMap((source) =>
          source === null
            ? Effect.succeed(null)
            : Effect.tryPromise({
                try: async () => {
                  const captured = await source.capture(MODAL_CAPTURE_TTL_MS);
                  if (captured === null) throw new Error("The chat's machine is not running");
                  captures.set(captured.imageId, { batchId: tag.batchId, copy: captured.copy });
                  return captured.imageId;
                },
                catch: (cause) => new ForkMachineError({ step: "capture", cause }),
              }),
        ),
      ),
    release: (captureId: string) =>
      attempt("capture", async ({ boxes }) => {
        captures.delete(captureId);
        await boxes.deleteImage(captureId);
      }),
    start: (captureId: string, tag: ForkTag, lifetimeMs: number) =>
      attempt("start", async ({ boxes }) => {
        const captured = captures.get(captureId);
        if (!captured) throw new Error("The capture of the chat's machine is gone");
        const forkId = await boxes.createCopy({
          ...captured.copy,
          imageId: captureId,
          timeoutMs: lifetimeMs,
          tags: { purpose: COPY_PURPOSE, host: tag.host, batch: tag.batchId, lease: tag.leaseId },
        });
        try {
          await exec(boxes, forkId, python(RECORD_ENV), 60_000);
        } catch (error) {
          await boxes.terminate(forkId).catch(() => undefined);
          throw error;
        }
        copies.add(forkId);
        return forkId;
      }),
    run: (forkId: string, job: Parameters<ForkMachines["Service"]["run"]>[1]) =>
      attempt("run", async ({ boxes }) =>
        decodeExit(await exec(boxes, forkId, python(RUN, job), job.timeoutMs + 60_000)),
      ),
    upload: (forkId: string, input: Parameters<ForkMachines["Service"]["upload"]>[1]) =>
      attempt("upload", async ({ boxes }) =>
        decodeUpload(await exec(boxes, forkId, python(UPLOAD, input), 3_700_000)),
      ),
    copyBack: (forkId: string, input: Parameters<ForkMachines["Service"]["copyBack"]>[1]) =>
      control.modalForkSource(input.sourceSandboxId).pipe(
        Effect.mapError((cause) => new ForkMachineError({ step: "copy", cause })),
        Effect.flatMap((source) =>
          attempt("copy", async ({ boxes }): Promise<ForkCopyBack> => {
            if (source === null) return { kind: "asleep" };
            const claimed = Number(
              await exec(
                boxes,
                forkId,
                python(PACK, { cwd: input.cwd, paths: input.paths }),
                600_000,
              ),
            );
            if (claimed > input.maxBytes) return { kind: "too_large", bytes: claimed };
            const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-"));
            try {
              const archive = NodePath.join(scratch, "copy.tgz");
              await boxes.download(forkId, `${STATE}/copy.tgz`, archive);
              // The copy reports its own archive's size, so the host checks what it received.
              const { size } = await NodeFSP.stat(archive);
              if (size > input.maxBytes) return { kind: "too_large", bytes: size };
              return { kind: await source.unpackInto(archive, input.destination) };
            } finally {
              await NodeFSP.rm(scratch, { recursive: true, force: true });
            }
          }),
        ),
      ),
    kill: (forkId: string) =>
      attempt("kill", async ({ boxes }) => {
        copies.delete(forkId);
        await boxes.terminate(forkId);
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("a worker fork could not be removed; it ends at its timeout", {
            forkId,
            cause: error.cause,
          }),
        ),
      ),
    sweep: (host: string, remove: (batchId: string) => boolean) =>
      attempt("sweep", async ({ boxes, app, environment }) => {
        const found = await boxes.list(app, environment, { purpose: COPY_PURPOSE, host });
        const doomed = found.filter((copy) => remove(copy.tags.batch ?? ""));
        const stale = [...captures].filter(([, captured]) => remove(captured.batchId));
        const results = [
          ...(await Promise.allSettled(
            doomed.map(({ sandboxId }) => {
              copies.delete(sandboxId);
              return boxes.terminate(sandboxId);
            }),
          )),
          ...(await Promise.allSettled(
            stale.map(([captureId]) => {
              captures.delete(captureId);
              return boxes.deleteImage(captureId);
            }),
          )),
        ];
        return {
          forks: doomed.length,
          captures: stale.length,
          failed: results.filter((result) => result.status === "rejected").length,
        };
      }),
  };
});

/**
 * Copies a chat's machine on its own provider: a Modal chat's on Modal, any other on E2B with the
 * host's own E2B key, which the chat's agent never holds. A capture or copy is Modal's when this
 * host made it there.
 */
export const layer = Layer.effect(
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
    // Every job waiting for room asks; one listing answers all of them for a few seconds.
    const listRunning = yield* Effect.cachedWithTTL(
      attempt("count", async (e2b, signal) => {
        const found: Array<Record<string, string>> = [];
        const listed = e2b.Sandbox.list({ query: { state: ["running"] }, limit: 100 });
        while (listed.hasNext)
          for (const sandbox of await listed.nextItems({ signal })) found.push(sandbox.metadata);
        return found;
      }),
      "10 seconds",
    );

    const e2b = ForkMachines.of({
      settings: (repository) =>
        control.controlConfig.pipe(
          Effect.map((config) =>
            config === null
              ? null
              : {
                  limits: config.provisioning?.workerForks ?? {},
                  services: serviceCommands(config, repository),
                },
          ),
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
          // A copy that was created is killed above before the error leaves, so a retry never
          // leaks one.
          Effect.mapError((error) =>
            e2bBusy(error.cause)
              ? new ForkMachineError({ step: error.step, cause: error.cause, busy: true })
              : error,
          ),
        ),

      othersRunning: (_captureId, host) =>
        listRunning.pipe(Effect.map((running) => othersOf(host, running))),

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
    const modal = yield* modalMachines;
    return ForkMachines.of({
      settings: e2b.settings,
      capture: (sandboxId, tag) =>
        modal
          .capture(sandboxId, tag)
          .pipe(
            Effect.flatMap((captureId) =>
              captureId === null ? e2b.capture(sandboxId, tag) : Effect.succeed(captureId),
            ),
          ),
      release: (captureId) =>
        modal.owns(captureId) ? modal.release(captureId) : e2b.release(captureId),
      start: (captureId, tag, lifetimeMs) =>
        modal.owns(captureId)
          ? modal.start(captureId, tag, lifetimeMs)
          : e2b.start(captureId, tag, lifetimeMs),
      othersRunning: (captureId, host) =>
        modal.owns(captureId) ? Effect.succeed(null) : e2b.othersRunning(captureId, host),
      run: (forkId, job) => (modal.owns(forkId) ? modal.run(forkId, job) : e2b.run(forkId, job)),
      upload: (forkId, input) =>
        modal.owns(forkId) ? modal.upload(forkId, input) : e2b.upload(forkId, input),
      copyBack: (forkId, input) =>
        modal.owns(forkId) ? modal.copyBack(forkId, input) : e2b.copyBack(forkId, input),
      kill: (forkId) => (modal.owns(forkId) ? modal.kill(forkId) : e2b.kill(forkId)),
      sweep: (host, remove) =>
        Effect.all([
          e2b.sweep(host, remove),
          // A host without Modal has no Modal copies to sweep.
          modal
            .sweep(host, remove)
            .pipe(Effect.catch(() => Effect.succeed({ forks: 0, captures: 0, failed: 0 }))),
        ]).pipe(
          Effect.map(([onE2b, onModal]) => ({
            forks: onE2b.forks + onModal.forks,
            captures: onE2b.captures + onModal.captures,
            failed: onE2b.failed + onModal.failed,
          })),
        ),
    });
  }),
);
