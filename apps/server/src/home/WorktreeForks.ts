// @effect-diagnostics nodeBuiltinImport:off - shipments, logs and outputs are files on this host.
/**
 * WorktreeForks - runs agents' heavy commands in throwaway Modal copies of their worktree, on a
 * self-hosted server that has its own Modal token in worktree-forks.json.
 *
 * A copy boots from the repository's base image (worktreeForkBases.ts), takes the worktree's
 * uncommitted state and new commits (worktreeForkShip.ts), mounts its checkout at the worktree's
 * own path, starts the repository's services, and runs the command with its output streamed back.
 * `t3 fork-exec` (through fork.sock) and t3_fork_run batches both run here, sharing one limit on
 * copies at once. The line between a copy that never ran the command and one that did is the
 * banner: before it, every failure lets the caller run the command itself (exit 75); after it, a
 * lost copy is exit 70. Batches live in memory: a restart ends them, and the sweep at start, then
 * every ten minutes, ends whatever sandboxes they left.
 *
 * @module WorktreeForks
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  type FleetForkBatch,
  type FleetForkCancelInput,
  type FleetForkJobState,
  type FleetForkRunInput,
  type FleetForkStatusInput,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { makeModalBoxes } from "../environmentControl/ModalRuntime.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeSlots } from "../environmentControl/forkSlots.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { type ForkExecRequest, portableEnvironment } from "./forkExecProtocol.ts";
import { type ForkBase, makeBases } from "./worktreeForkBases.ts";
import {
  COPY_PURPOSE,
  copySpec,
  type ForkSandboxes,
  readWorktreeForksConfig,
  type SandboxSize,
  type WorktreeForksHost,
} from "./worktreeForksConfig.ts";
import {
  applyArgv,
  type Checkout,
  inspectCheckout,
  packInputs,
  sandboxEnvironment,
  type Shipment,
  shipState,
} from "./worktreeForkShip.ts";
import { placeOutputs, refusedPath } from "./worktreeForkPaths.ts";

/** Time a copy keeps beyond its job's timeout for applying, services and outputs. */
const SETUP_MS = 20 * 60_000;
const SERVICES_TIMEOUT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 10 * 60_000;
const FINISHED_BATCH_TTL_MS = 6 * 3_600_000;
const RESULTS_TTL_MS = 24 * 3_600_000;
const MAX_RUNNING_BATCHES_PER_OWNER = 4;
const TAIL_CHARS = 4_000;
const ARCHIVE = "/tmp/t3-state.tar";
const INPUTS = "/tmp/t3-inputs.tgz";
const OUTPUTS = "/tmp/t3-outputs.tgz";

export type OutputSink = (stream: "stdout" | "stderr", text: string) => void;

export interface ExecObserver {
  /** The command is about to run, so the caller may print its banner. Called at most once. */
  readonly started: (jobId: string) => Effect.Effect<void>;
  readonly output: OutputSink;
}

export type ExecOutcome =
  | {
      readonly _tag: "Exited";
      readonly exitCode: number;
      readonly timedOut: boolean;
      readonly durationMs: number;
    }
  /** Nothing of the command ran: the caller may run it itself. */
  | { readonly _tag: "NotStarted"; readonly message: string }
  /** The command started and its copy was lost: it may have run partly. */
  | { readonly _tag: "Lost"; readonly message: string };

export class WorktreeForks extends Context.Service<
  WorktreeForks,
  {
    /** This host runs its own copies. Transports keep their old path when false. */
    readonly enabled: boolean;
    /** The bun shim's settings, or null when this host has none. */
    readonly bunShim: WorktreeForksHost["bunShim"];
    /** One command for `t3 fork-exec`. Interrupting it ends its copy. */
    readonly exec: (request: ForkExecRequest, observer: ExecObserver) => Effect.Effect<ExecOutcome>;
    /** Starts a batch for `owner` and answers at once with every job queued. */
    readonly run: (
      owner: ThreadId,
      input: FleetForkRunInput,
    ) => Effect.Effect<FleetForkBatch, OrchestratorMcpFailure>;
    readonly status: (
      owner: ThreadId,
      input: FleetForkStatusInput,
    ) => Effect.Effect<FleetForkBatch, OrchestratorMcpFailure>;
    /** Ends the batch's named jobs, or all of them; a job already finished stays as it ended. */
    readonly cancel: (
      owner: ThreadId,
      input: FleetForkCancelInput,
    ) => Effect.Effect<FleetForkBatch, OrchestratorMcpFailure>;
  }
>()("t3/home/WorktreeForks") {}

/**
 * Nothing of the command ran. `reason` is what the caller is told; when a repository's service
 * failed it carries that service's last 2,000 characters of output, since the agent that asked
 * needs them to see why, as with DeviceBootError's diagnostics.
 */
class NotStarted extends Schema.TaggedError<NotStarted>()("NotStarted", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

/** The command started and its copy stopped answering. */
class Lost extends Schema.TaggedError<Lost>()("Lost", { cause: Schema.Defect() }) {
  override get message(): string {
    return "Its Modal sandbox stopped answering.";
  }
}

const notStarted = (error: { readonly message: string }) =>
  new NotStarted({ reason: error.message, cause: error });

/** Which path sent a job: the bun shim, another `t3 fork-exec` call, or t3_fork_run. */
type ForkCaller = "bun-shim" | "fork-exec" | "fork-run";

const callerOf = (request: ForkExecRequest): ForkCaller =>
  request.environment.T3CODE_FORK_CALLER === "bun-shim" ? "bun-shim" : "fork-exec";

/** The command on one log line, with the value of every `NAME=value` word left out. */
const commandSummary = (command: string) => {
  const summary = command
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^| )([A-Za-z_]\w*)=('[^']*'|"[^"]*"|\S*)/g, "$1$2=…");
  return summary.length <= 160 ? summary : `${summary.slice(0, 159)}…`;
};

interface CopyJob {
  readonly id: string;
  readonly caller: ForkCaller;
  readonly command: string;
  readonly cwd: string;
  /** Already mapped for the copy. */
  readonly environment: Readonly<Record<string, string>>;
  readonly size: SandboxSize;
  readonly timeoutMs: number;
  /** Host paths packed for the copy to unpack at the same paths. */
  readonly inputs: { readonly archive: string; readonly bytes: number } | null;
  /**
   * Paths under `root` in the copy that come back under `into` here, through `archive`. With
   * `place`, `into` only stages them, and each then replaces its own host path (placeOutputs).
   */
  readonly outputs: {
    readonly paths: ReadonlyArray<string>;
    readonly root: string;
    readonly into: string;
    readonly archive: string;
    readonly place?: true;
  } | null;
}

/** A checkout's state shipped against the base its copies boot from. */
interface Target {
  readonly shipment: Shipment;
  readonly base: ForkBase;
}

/** Where one batch job runs: its directory as the copy sees it, and its checkout's target. */
interface JobTarget {
  readonly cwd: string;
  readonly target: Deferred.Deferred<Target, NotStarted>;
}

interface Exited {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly copiedTo?: string;
  readonly outputsProblem?: string;
}

/**
 * Moves the copy's checkout to the worktree's own path, so pwd, git and stack traces all agree,
 * and leaves the base's path as a symlink to it. A bind mount would also show the path, but Linux
 * refuses rename(2) across mount points, so a test moving a file into /tmp failed with EXDEV.
 */
const PLACE_SCRIPT = `mkdir -p "$(dirname "$1")" && mv "$2" "$1" && ln -s "$1" "$2"`;

/** Unpacks the inputs at their host paths, once the checkout sits at its own. */
const INPUTS_SCRIPT = `tar -xzf "$1" --no-same-owner -C /`;

/**
 * Runs the command as a child subreaper. Modal's agent is PID 1 in a copy and never reaps, so a
 * killed orphan stayed a zombie that still answered kill(pid, 0); on the host, the user's service
 * manager reaps it. Exits with the command's code, or 128 plus the signal that ended it.
 */
const SUBREAPER = `import ctypes, os, subprocess, sys
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)
child = subprocess.Popen(sys.argv[1:])
while True:
    pid, status = os.wait()
    if pid == child.pid:
        code = os.waitstatus_to_exitcode(status)
        sys.exit(code if code >= 0 else 128 - code)`;

/**
 * Runs each service command to its end, as a chat's copy does; one that leaves a daemon behind
 * must not hold the exec's output open, so output goes to a log whose tail explains a failure.
 */
const SERVICES_SCRIPT = `for service in "$@"; do
  bash -lc "$service" >> /tmp/t3-services.log 2>&1 < /dev/null || { code=$?; tail -c 2000 /tmp/t3-services.log; exit "$code"; }
done`;

/** Packs $3... (relative to $1) into one archive under $2 bytes; names missing ones on stdout. */
const OUTPUTS_SCRIPT = `cd "$1" && max=$2 && shift 2 && : > /tmp/t3-outputs.list
for path in "$@"; do
  if [ -e "$path" ]; then printf '%s\\0' "$path" >> /tmp/t3-outputs.list; else printf '%s\\0' "$path"; fi
done
tar -czf ${OUTPUTS} --null -T /tmp/t3-outputs.list 2>/dev/null || exit 3
size=$(wc -c < ${OUTPUTS})
[ "$size" -le "$max" ] || { echo "$size" >&2; exit 4; }`;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const unfinished = (job: FleetForkJobState) => job.state === "queued" || job.state === "running";

interface Batch {
  readonly id: string;
  readonly owner: ThreadId;
  readonly jobs: Array<FleetForkJobState>;
  readonly cancels: ReadonlyArray<Deferred.Deferred<void>>;
  readonly done: Deferred.Deferred<void>;
  readonly resultsDir: string;
  finishedAt: number | null;
}

/** Records a job's next state. Exited, failed and cancelled are final. */
const setJob = (batch: Batch, next: FleetForkJobState) => {
  if (unfinished(batch.jobs[next.index]!)) batch.jobs[next.index] = next;
};

const view = (batch: Batch): FleetForkBatch => ({
  batchId: batch.id,
  state: batch.finishedAt === null ? "running" : "finished",
  jobs: [...batch.jobs],
});

const disabled = WorktreeForks.of({
  enabled: false,
  bunShim: null,
  exec: () =>
    Effect.succeed({ _tag: "NotStarted", message: "This host has no worktree forks set up." }),
  run: () => Effect.fail(failure("environment_unavailable", "This host has no worktree forks.")),
  status: () => Effect.fail(failure("environment_unavailable", "This host has no worktree forks.")),
  cancel: () => Effect.fail(failure("environment_unavailable", "This host has no worktree forks.")),
});

/** The service over `host`'s configuration and a Modal port. */
export const make = Effect.fn("WorktreeForks.make")(function* (
  host: WorktreeForksHost,
  sandboxes: ForkSandboxes,
) {
  const { stateDir, baseDir: t3Home } = yield* ServerConfig;
  const hostTag = (yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor).environmentId;
  const hostHome = yield* HostProcess.HomeDirectory;
  const serverEnvironment = yield* HostProcess.Environment;
  const runner = yield* ProcessRunner.ProcessRunner;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const scope = yield* Effect.scope;
  const slots = makeSlots(host.maxConcurrent);
  /** Job tags whose sandboxes are this run's to keep; the sweep ends every other one. */
  const live = new Set<string>();
  const bases = yield* makeBases(host, sandboxes, hostTag, live);
  const batches = new Map<string, Batch>();
  const scratchRoot = NodePath.join(stateDir, "worktree-forks", "tmp");
  const resultsRoot = NodePath.join(stateDir, "fork-results");
  yield* Effect.sync(() => NodeFS.rmSync(scratchRoot, { recursive: true, force: true }));

  /** A directory on this host that lasts as long as the scope. */
  const scratchDir = Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodePath.join(scratchRoot, NodeCrypto.randomUUID());
      NodeFS.mkdirSync(dir, { recursive: true });
      return dir;
    }),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

  /** Fails as "the copy could not <what>", so nothing of the command ran. */
  const couldNot = (what: string) => (cause: unknown) =>
    new NotStarted({ reason: `The copy could not ${what}.`, cause });

  // Steps of one job, inside its prepare or outputs span.
  const step = Effect.fnUntraced(function* (
    sandboxId: string,
    argv: ReadonlyArray<string>,
    what: string,
    options: {
      readonly env?: Readonly<Record<string, string>>;
      readonly workdir?: string;
      readonly timeoutMs?: number;
    } = {},
  ) {
    return yield* Effect.tryPromise({
      try: () => sandboxes.exec(sandboxId, argv, { timeoutMs: STEP_TIMEOUT_MS, ...options }),
      catch: couldNot(what),
    });
  });
  const stepSucceeds: typeof step = Effect.fnUntraced(function* (sandboxId, argv, what, options) {
    const result = yield* step(sandboxId, argv, what, options);
    if (result.exitCode !== 0)
      return yield* couldNot(what)(
        new Error(`exited ${result.exitCode}: ${`${result.stdout}${result.stderr}`.slice(-2000)}`),
      );
    return result;
  });

  const inspect = (cwd: string) =>
    inspectCheckout(cwd, host.repositories).pipe(
      Effect.mapError(notStarted),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
  const ship = (checkout: Checkout, base: ForkBase, dir: string) =>
    shipState(checkout, base.sha, dir).pipe(
      Effect.mapError(notStarted),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );

  /** Everything before the command: any failure here means nothing of it ran. */
  const prepare = Effect.fn("WorktreeForks.prepare")(function* (
    job: CopyJob,
    shipment: Shipment,
    imageId: string,
  ) {
    const { checkout } = shipment;
    const sandboxId = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          live.add(job.id);
          return sandboxes.createCopy(
            copySpec(host, {
              imageId,
              size: job.size,
              lifetimeMs: job.timeoutMs + SETUP_MS,
              tags: { purpose: COPY_PURPOSE, host: hostTag, job: job.id },
            }),
          );
        },
        catch: (cause) => new NotStarted({ reason: "Modal could not start a copy.", cause }),
      }),
      (id) =>
        Effect.promise(() => sandboxes.terminate(id).catch(() => undefined)).pipe(
          Effect.ensuring(Effect.sync(() => live.delete(job.id))),
        ),
    ).pipe(Effect.onError(() => Effect.sync(() => live.delete(job.id))));
    yield* Effect.tryPromise({
      try: () => sandboxes.upload(sandboxId, shipment.archive, ARCHIVE),
      catch: couldNot("receive this worktree's state"),
    });
    yield* stepSucceeds(sandboxId, applyArgv(shipment, ARCHIVE), "apply this worktree's state", {
      env: job.environment,
    });
    yield* stepSucceeds(
      sandboxId,
      ["sh", "-c", PLACE_SCRIPT, "t3-place", checkout.root, checkout.repository.workDir],
      "move its checkout to this worktree's path",
    );
    if (job.inputs !== null) {
      const { archive } = job.inputs;
      yield* Effect.tryPromise({
        try: () => sandboxes.upload(sandboxId, archive, INPUTS),
        catch: couldNot("receive the command's inputs"),
      });
      yield* stepSucceeds(
        sandboxId,
        ["sh", "-c", INPUTS_SCRIPT, "t3-inputs", INPUTS],
        "unpack the command's inputs",
      );
    }
    if (checkout.repository.services.length > 0) {
      const services = yield* step(
        sandboxId,
        ["sh", "-c", SERVICES_SCRIPT, "t3-services", ...checkout.repository.services],
        "start this repository's services",
        { env: job.environment, workdir: checkout.root, timeoutMs: SERVICES_TIMEOUT_MS },
      );
      if (services.exitCode !== 0)
        return yield* new NotStarted({
          reason: `A service of this repository exited ${services.exitCode} in the copy:\n${services.stdout.slice(-2000)}`,
        });
    }
    return sandboxId;
  });

  /** Brings listed outputs back under `into`. Never fails: a problem is reported instead. */
  const collectOutputs = Effect.fn("WorktreeForks.collectOutputs")(function* (
    sandboxId: string,
    outputs: NonNullable<CopyJob["outputs"]>,
  ) {
    const packed = yield* step(
      sandboxId,
      [
        "sh",
        "-c",
        OUTPUTS_SCRIPT,
        "t3-outputs",
        outputs.root,
        String(host.maxCopyBackBytes),
        ...outputs.paths,
      ],
      "pack its outputs",
    ).pipe(Effect.option);
    if (Option.isNone(packed)) return { outputsProblem: "Packing the outputs failed." };
    const { exitCode, stdout, stderr } = packed.value;
    if (exitCode === 4)
      return {
        outputsProblem: `The outputs are ${Math.ceil(Number(stderr.trim()) / 1048576)} MiB compressed, over the ${Math.floor(host.maxCopyBackBytes / 1048576)} MiB copy-back limit.`,
      };
    if (exitCode !== 0) return { outputsProblem: "Packing the outputs failed." };
    const local = outputs.archive;
    const unpacked = yield* Effect.tryPromise(() =>
      sandboxes.download(sandboxId, OUTPUTS, local),
    ).pipe(
      Effect.andThen(Effect.sync(() => NodeFS.mkdirSync(outputs.into, { recursive: true }))),
      Effect.andThen(runner.run({ command: "tar", args: ["-xzf", local, "-C", outputs.into] })),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(local, { force: true }))),
      Effect.option,
    );
    if (Option.isNone(unpacked) || Number(unpacked.value.code) !== 0)
      return { outputsProblem: "Copying the outputs back failed." };
    if (outputs.place) {
      const placed = yield* Effect.try({
        try: () => placeOutputs(outputs.into, outputs.paths, NodeCrypto.randomUUID()),
        catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
      }).pipe(Effect.result);
      if (Result.isFailure(placed)) return { outputsProblem: placed.failure };
    }
    const missing = stdout.split("\0").filter((path) => path !== "");
    return {
      copiedTo: outputs.into,
      ...(missing.length === 0 ? {} : { outputsProblem: `Not found: ${missing.join(", ")}.` }),
    };
  });

  /** The command itself: any failure here means it may have partly run. */
  const execute = Effect.fn("WorktreeForks.execute")(function* (
    sandboxId: string,
    job: CopyJob,
    output: OutputSink,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    // Host-side, since Modal counts an exec's timeout in whole seconds; its own is a backstop.
    const exitCode = yield* Effect.tryPromise({
      try: () =>
        sandboxes.execStream(sandboxId, ["python3", "-c", SUBREAPER, "bash", "-lc", job.command], {
          env: job.environment,
          workdir: job.cwd,
          timeoutMs: job.timeoutMs + 60_000,
          onOutput: output,
        }),
      catch: (cause) => new Lost({ cause }),
    }).pipe(Effect.timeoutOption(Duration.millis(job.timeoutMs)));
    const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
    if (Option.isNone(exitCode))
      return { exitCode: 124, timedOut: true, durationMs } satisfies Exited;
    const outputs = job.outputs === null ? {} : yield* collectOutputs(sandboxId, job.outputs);
    return { exitCode: exitCode.value, timedOut: false, durationMs, ...outputs } satisfies Exited;
  });

  /** One copy: waits for a slot, prepares, announces the start, runs. Its sandbox always ends. */
  const runJob = Effect.fn("WorktreeForks.runJob")(function* (
    job: CopyJob,
    shipment: Shipment,
    base: ForkBase,
    observer: ExecObserver,
  ) {
    const queuedAt = yield* Clock.currentTimeMillis;
    return yield* slots.withSlot(
      Effect.scoped(
        Effect.gen(function* () {
          const setupAt = yield* Clock.currentTimeMillis;
          const sandboxId = yield* prepare(job, shipment, base.imageId);
          yield* observer.started(job.id);
          const commandAt = yield* Clock.currentTimeMillis;
          const exited = yield* execute(sandboxId, job, observer.output);
          // One line per finished copy, so this host's offload use can be read from its log.
          yield* Effect.logInfo("worktree fork job finished", {
            job: job.id,
            caller: job.caller,
            command: commandSummary(job.command),
            repository: shipment.checkout.repository.repository,
            cpu: job.size.cpu,
            memoryMiB: job.size.memoryMiB,
            shippedBytes: NodeFS.statSync(shipment.archive, { throwIfNoEntry: false })?.size,
            inputBytes: job.inputs?.bytes,
            exitCode: exited.exitCode,
            timedOut: exited.timedOut,
            queuedMs: setupAt - queuedAt,
            setupMs: commandAt - setupAt,
            commandMs: exited.durationMs,
          });
          return exited;
        }),
      ),
    );
  });

  /** Logged where an outcome is decided, so a refusal before any copy exists says why too. */
  const logFailure = (error: NotStarted | Lost, job: Pick<CopyJob, "cwd" | "caller" | "command">) =>
    Effect.logWarning(
      error._tag === "Lost" ? "worktree fork copy lost" : "worktree fork copy did not start",
      {
        cwd: job.cwd,
        caller: job.caller,
        command: commandSummary(job.command),
        reason: error.message,
        cause: error.cause,
      },
    );

  const sizeOf = (name: string | undefined) => host.sizes.get(name ?? host.defaultSize);
  const unknownSize = (name: string | undefined) =>
    `This host has no size ${name}; it has ${[...host.sizes.keys()].join(", ")}.`;
  const timeoutOf = (seconds: number | undefined) =>
    Math.min((seconds ?? Infinity) * 1000, host.maxJobMs);

  const exec: WorktreeForks["Service"]["exec"] = Effect.fn("WorktreeForks.exec")(
    function* (request, observer) {
      const size = sizeOf(request.size);
      if (size === undefined) return yield* new NotStarted({ reason: unknownSize(request.size) });
      const refused = [
        ...(request.inputs ?? []).map((path) => refusedPath(path, "input", t3Home, hostHome)),
        ...(request.outputs ?? []).map((path) => refusedPath(path, "output", t3Home, hostHome)),
      ].find((reason) => reason !== null);
      if (refused !== undefined) return yield* new NotStarted({ reason: refused });
      const checkout = yield* inspect(request.cwd);
      // The first base takes minutes; this run goes back to the caller rather than wait for it.
      const base = yield* bases.current(checkout, false).pipe(Effect.mapError(notStarted));
      const dir = yield* scratchDir;
      const shipment = yield* ship(checkout, base, dir);
      const inputs =
        (request.inputs ?? []).length === 0
          ? null
          : yield* packInputs(request.inputs!, dir).pipe(
              Effect.mapError(notStarted),
              Effect.provideService(ProcessRunner.ProcessRunner, runner),
            );
      const exited: Exited = yield* runJob(
        {
          id: NodeCrypto.randomUUID(),
          caller: callerOf(request),
          command: request.command,
          cwd: checkout.cwd,
          environment: sandboxEnvironment(request.environment, checkout.root, hostHome),
          size,
          timeoutMs: timeoutOf(request.timeoutSeconds),
          inputs,
          // Absolute paths, so they pack from the copy's root and unpack at this host's.
          outputs:
            (request.outputs ?? []).length === 0
              ? null
              : {
                  paths: request.outputs!,
                  root: "/",
                  into: NodePath.join(dir, "outputs"),
                  archive: NodePath.join(dir, "outputs.tgz"),
                  place: true,
                },
        },
        shipment,
        base,
        observer,
      );
      if ((request.outputs ?? []).length > 0) {
        const problem = exited.timedOut
          ? "The command timed out, so its outputs were not copied back."
          : exited.copiedTo === undefined
            ? `The outputs were not copied back: ${exited.outputsProblem}`
            : exited.outputsProblem;
        if (problem !== undefined) observer.output("stderr", `[t3] ${problem}\n`);
      }
      return {
        _tag: "Exited",
        exitCode: exited.exitCode,
        timedOut: exited.timedOut,
        durationMs: exited.durationMs,
      } satisfies ExecOutcome;
    },
    (effect, request) =>
      effect.pipe(
        Effect.scoped,
        Effect.tapError((error) => logFailure(error, { ...request, caller: callerOf(request) })),
        Effect.catchTags({
          NotStarted: (error) =>
            Effect.succeed<ExecOutcome>({ _tag: "NotStarted", message: error.message }),
          Lost: (error) => Effect.succeed<ExecOutcome>({ _tag: "Lost", message: error.message }),
        }),
      ),
  );

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, batch] of batches)
      if (batch.finishedAt !== null && now - batch.finishedAt > FINISHED_BATCH_TTL_MS)
        batches.delete(id);
  });

  /** Where a thread's jobs run when they name no cwd: its worktree, else its project's root. */
  const defaultCwd = Effect.fn("WorktreeForks.defaultCwd")(function* (owner: ThreadId) {
    const shell = yield* threads.getThreadShell(owner).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return null;
    if (shell.worktreePath !== null) return shell.worktreePath;
    const project = yield* projects
      .getById(shell.projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(project) ? project.value.workspaceRoot : null;
  });

  /** One batch job's copy, with its output in log files and its outcome in the batch. */
  const runBatchJob = Effect.fn("WorktreeForks.runBatchJob")(
    function* (batch: Batch, input: FleetForkRunInput, index: number, target: JobTarget) {
      if (batch.jobs[index]!.state === "cancelled") return;
      const job = input.jobs[index]!;
      const { shipment, base } = yield* Deferred.await(target.target);
      const dir = NodePath.join(batch.resultsDir, `job-${index}`);
      const tails = { stdout: "", stderr: "" };
      const files = yield* Effect.acquireRelease(
        Effect.sync(() => {
          NodeFS.mkdirSync(dir, { recursive: true });
          return {
            stdout: NodeFS.openSync(NodePath.join(dir, "stdout.log"), "a"),
            stderr: NodeFS.openSync(NodePath.join(dir, "stderr.log"), "a"),
          };
        }),
        (opened) =>
          Effect.sync(() => {
            NodeFS.closeSync(opened.stdout);
            NodeFS.closeSync(opened.stderr);
          }),
      );
      const exited = yield* runJob(
        {
          id: `${batch.id}-${index}`,
          caller: "fork-run",
          command: job.command,
          cwd: target.cwd,
          environment: sandboxEnvironment(
            portableEnvironment(serverEnvironment),
            shipment.checkout.root,
            hostHome,
          ),
          size: sizeOf(job.size)!,
          timeoutMs: timeoutOf(job.timeoutSeconds),
          inputs: null,
          outputs:
            (job.outputs ?? []).length === 0
              ? null
              : {
                  paths: job.outputs!,
                  root: target.cwd,
                  into: NodePath.join(dir, "outputs"),
                  archive: NodePath.join(dir, "outputs.tgz"),
                },
        },
        shipment,
        base,
        {
          started: () => Effect.sync(() => setJob(batch, { index, state: "running" })),
          output: (stream, text) => {
            NodeFS.writeSync(files[stream], text);
            tails[stream] = (tails[stream] + text).slice(-TAIL_CHARS);
          },
        },
      );
      setJob(batch, {
        index,
        state: "exited",
        ...exited,
        stdoutTail: tails.stdout,
        stderrTail: tails.stderr,
        logsUri: `${dir}/`,
      });
    },
    (effect, batch, input, index, target) =>
      effect.pipe(
        Effect.scoped,
        Effect.tapError((error) =>
          logFailure(error, {
            cwd: target.cwd,
            caller: "fork-run",
            command: input.jobs[index]!.command,
          }),
        ),
        Effect.catchTags({
          NotStarted: (error) =>
            Effect.sync(() => setJob(batch, { index, state: "failed", message: error.message })),
          Lost: (error) =>
            Effect.sync(() =>
              setJob(batch, {
                index,
                state: "failed",
                message: `The copy running the job was lost: ${error.message}`,
              }),
            ),
        }),
      ),
  );

  const runBatch = Effect.fn("WorktreeForks.runBatch")(
    function* (batch: Batch, input: FleetForkRunInput, fallbackCwd: string | null) {
      const environment = portableEnvironment(serverEnvironment);
      // Every job of a checkout sees the same state, shipped once as the batch starts. The wait
      // for a first base and the shipping run beside the jobs, so cancelling a job ends its wait.
      const byRoot = new Map<string, Deferred.Deferred<Target, NotStarted>>();
      // Within this batch's span; the forked shipping has the base and ship spans of its own.
      const shipOnce = Effect.fnUntraced(function* (checkout: Checkout) {
        const known = byRoot.get(checkout.root);
        if (known !== undefined) return known;
        const target = Deferred.makeUnsafe<Target, NotStarted>();
        byRoot.set(checkout.root, target);
        yield* Effect.gen(function* () {
          const base = yield* bases.current(checkout, true).pipe(Effect.mapError(notStarted));
          const shipment = yield* ship(checkout, base, yield* scratchDir);
          return { shipment, base };
        }).pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(target, exit)),
          Effect.forkScoped,
        );
        return target;
      });
      const byCwd = new Map<string, JobTarget>();
      const targets = yield* Effect.forEach(input.jobs, (job) => {
        const cwd = job.cwd ?? fallbackCwd!;
        const known = byCwd.get(cwd);
        if (known !== undefined) return Effect.succeed(known);
        return inspect(cwd).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const target = Deferred.makeUnsafe<Target, NotStarted>();
              return Deferred.fail(target, error).pipe(Effect.as({ cwd, target }));
            },
            onSuccess: (checkout) =>
              shipOnce(checkout).pipe(Effect.map((target) => ({ cwd: checkout.cwd, target }))),
          }),
          Effect.tap((target) => Effect.sync(() => byCwd.set(cwd, target))),
        );
      });
      yield* Effect.forEach(
        input.jobs.map((_, index) => index),
        (index) =>
          Effect.raceFirst(
            runBatchJob(batch, input, index, targets[index]!),
            Deferred.await(batch.cancels[index]!),
          ),
        {
          concurrency: Math.min(input.concurrency ?? host.maxConcurrent, host.maxConcurrent),
          discard: true,
        },
      );
    },
    (effect, batch) =>
      effect.pipe(
        Effect.scoped,
        Effect.ensuring(
          Effect.gen(function* () {
            batch.finishedAt = yield* Clock.currentTimeMillis;
            yield* Deferred.succeed(batch.done, undefined);
          }),
        ),
      ),
  );

  const run: WorktreeForks["Service"]["run"] = Effect.fn("WorktreeForks.run")(
    function* (owner, input) {
      for (const job of input.jobs) {
        if (job.cwd !== undefined && !job.cwd.startsWith("/"))
          return yield* failure("invalid_request", "A job's cwd must be an absolute path.");
        if ((job.outputs ?? []).some((path) => path.split("/").includes("..")))
          return yield* failure("invalid_request", "Output paths cannot contain '..'.");
        if (sizeOf(job.size) === undefined)
          return yield* failure("invalid_request", unknownSize(job.size));
      }
      const fallbackCwd = input.jobs.every((job) => job.cwd !== undefined)
        ? null
        : yield* defaultCwd(owner);
      if (fallbackCwd === null && input.jobs.some((job) => job.cwd === undefined))
        return yield* failure(
          "invalid_request",
          "This thread has no checkout to run in; give each job a cwd.",
        );
      yield* prune;
      const running = [...batches.values()].filter(
        (batch) => batch.owner === owner && batch.finishedAt === null,
      );
      if (running.length >= MAX_RUNNING_BATCHES_PER_OWNER)
        return yield* failure(
          "invalid_request",
          `This chat already has ${running.length} fork batches running (${running.map((batch) => batch.id).join(", ")}). Wait for one with t3_fork_status, then start the next.`,
        );
      const id = NodeCrypto.randomUUID();
      const batch: Batch = {
        id,
        owner,
        jobs: input.jobs.map((_, index) => ({ index, state: "queued" as const })),
        cancels: input.jobs.map(() => Deferred.makeUnsafe<void>()),
        done: Deferred.makeUnsafe<void>(),
        resultsDir: NodePath.join(resultsRoot, id),
        finishedAt: null,
      };
      batches.set(id, batch);
      yield* runBatch(batch, input, fallbackCwd).pipe(Effect.forkIn(scope));
      return view(batch);
    },
  );

  const owned = Effect.fn("WorktreeForks.owned")(function* (owner: ThreadId, batchId: string) {
    yield* prune;
    const batch = batches.get(batchId);
    if (batch === undefined || batch.owner !== owner)
      return yield* failure(
        "invalid_request",
        `No fork batch ${batchId} for this chat. Finished batches are kept six hours, and a server restart ends running ones.`,
      );
    return batch;
  });

  const status: WorktreeForks["Service"]["status"] = Effect.fn("WorktreeForks.status")(
    function* (owner, input) {
      const batch = yield* owned(owner, input.batchId);
      yield* Deferred.await(batch.done).pipe(
        Effect.timeoutOption(Duration.seconds(input.waitSeconds ?? 0)),
      );
      return view(batch);
    },
  );

  const cancel: WorktreeForks["Service"]["cancel"] = Effect.fn("WorktreeForks.cancel")(
    function* (owner, input) {
      const batch = yield* owned(owner, input.batchId);
      const indexes = input.jobs ?? batch.jobs.map((job) => job.index);
      const missing = indexes.find((index) => index >= batch.jobs.length);
      if (missing !== undefined)
        return yield* failure("invalid_request", `Fork batch ${batch.id} has no job ${missing}.`);
      const ending = indexes.filter((index) => unfinished(batch.jobs[index]!));
      // Every job is marked before any is interrupted, so a slot one frees cannot start another.
      for (const index of ending) batch.jobs[index] = { index, state: "cancelled" };
      for (const index of ending) yield* Deferred.succeed(batch.cancels[index]!, undefined);
      return view(batch);
    },
  );

  /** Ends this host's sandboxes that no running job or build owns, and old results. */
  const sweep = Effect.gen(function* () {
    const found = yield* Effect.tryPromise(() =>
      sandboxes.list(host.modal.app, host.modal.environment, {
        purpose: COPY_PURPOSE,
        host: hostTag,
      }),
    );
    for (const sandbox of found)
      if (!live.has(sandbox.tags.job ?? ""))
        yield* Effect.tryPromise(() => sandboxes.terminate(sandbox.sandboxId)).pipe(Effect.ignore);
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.sync(() => {
      for (const entry of NodeFS.existsSync(resultsRoot) ? NodeFS.readdirSync(resultsRoot) : []) {
        const path = NodePath.join(resultsRoot, entry);
        if (!batches.has(entry) && now - NodeFS.statSync(path).mtimeMs > RESULTS_TTL_MS)
          NodeFS.rmSync(path, { recursive: true, force: true });
      }
    });
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("worktree forks could not be swept", { cause })),
  );
  yield* sweep.pipe(Effect.repeat(Schedule.spaced("10 minutes")), Effect.forkIn(scope));

  return WorktreeForks.of({ enabled: true, bunShim: host.bunShim, exec, run, status, cancel });
});

/**
 * Reads worktree-forks.json once. A cloud box keeps its manager's forks, and a host without the
 * file, or with one that does not decode, has none.
 */
export const layer = Layer.effect(
  WorktreeForks,
  Effect.gen(function* () {
    if ((yield* HostProcess.Environment).T3CODE_USAGE_HOST_ID?.trim()) return disabled;
    const host = yield* readWorktreeForksConfig((yield* ServerConfig).stateDir).pipe(
      Effect.catchTags({
        WorktreeForksConfigError: (error) =>
          Effect.logError("worktree forks stay off: worktree-forks.json is invalid", {
            path: error.path,
            cause: error.cause,
          }).pipe(Effect.as(null)),
      }),
    );
    if (host === null) return disabled;
    return yield* make(host, makeModalBoxes(host.modal));
  }),
);
