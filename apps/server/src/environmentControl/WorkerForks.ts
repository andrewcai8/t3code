/**
 * WorkerForks - runs a cloud chat's jobs in throwaway copies of its machine (t3_fork_run).
 *
 * A chat's box is one sandbox with fixed CPU, memory and disk. Parallel work there (many
 * worktrees with installs, eval replays) fills the disk and crawls. Here the host copies the
 * chat's machine once per job, so each job starts with everything the chat already installed,
 * runs alone, and is thrown away. The host holds the provider key and decides limits; the box only
 * asks over its fleet channel. Copies are never leases or chats: nothing registers them, so they
 * never appear in a sidebar or receive fleet calls.
 *
 * Who may ask is CloudFleetHost's call, from the host's own records: the box's own chat, in
 * full-access/default mode. This service trusts the source and actor it is given.
 *
 * A batch outlives the call that started it. Capturing the chat's machine pauses it, which drops
 * the fleet connection the call came in on, so `run` only reserves the batch and answers with its
 * id; its caller starts the batch once that answer is delivered, and `status` reports on it. Batches live in memory: a host
 * restart ends them, and the sweep at start, then every few minutes, removes what they left.
 *
 * @module WorkerForks
 */
import {
  type DiscoveredProvisionedEnvironment,
  type FleetActor,
  type FleetForkBatch,
  type FleetForkJobState,
  type FleetForkRunInput,
  type FleetForkStatusInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ForkMachines from "./ForkMachines.ts";

type Box = DiscoveredProvisionedEnvironment;

/** Where copied-back outputs land on the chat's machine, one folder per batch and job. */
const RESULTS_ROOT = "/home/user/fork-results";
/** Time a copy keeps after its job's timeout, for uploading and copying back. */
const AFTER_JOB_MS = 15 * 60_000;
/** A job whose copy has not answered this long after its timeout has lost its copy. */
const RUN_GRACE_MS = 5 * 60_000;
const FINISHED_BATCH_TTL_MS = 6 * 3_600_000;
const MAX_RUNNING_BATCHES_PER_CHAT = 4;
/** E2B keeps no sandbox longer than a day. */
const MAX_LIFETIME_MS = 86_400_000;

interface ForkLimits {
  readonly maxPerChat: number;
  readonly maxPerHost: number;
  readonly maxJobMs: number;
  readonly maxCopyBackBytes: number;
  readonly outputsUri: string | undefined;
}

const forkLimits = (settings: ForkMachines.WorkerForkSettings): ForkLimits => ({
  maxPerChat: settings.maxPerChat ?? 8,
  maxPerHost: settings.maxPerHost ?? 20,
  maxJobMs: (settings.maxJobMinutes ?? 120) * 60_000,
  maxCopyBackBytes: (settings.maxCopyBackMiB ?? 100) * 1024 * 1024,
  outputsUri: settings.outputsUri?.replace(/\/+$/, ""),
});

/**
 * A batch reserved for a chat, and what starts it. Starting captures the chat's machine, so the
 * caller answers the chat with `batch` first; `start` runs once however often it is called.
 */
export interface ReservedBatch {
  readonly batch: FleetForkBatch;
  readonly start: Effect.Effect<void>;
}

export class WorkerForks extends Context.Service<
  WorkerForks,
  {
    /** Reserves a batch for `source`'s chat, or joins the same batch already reserved. */
    readonly run: (
      source: Box,
      actor: FleetActor,
      input: FleetForkRunInput,
    ) => Effect.Effect<ReservedBatch, OrchestratorMcpFailure>;
    readonly status: (
      source: Box,
      input: FleetForkStatusInput,
    ) => Effect.Effect<FleetForkBatch, OrchestratorMcpFailure>;
    /**
     * Removes this host's copies and captures that no running batch owns: what a previous run
     * left, and what a batch's own clean-up could not remove.
     */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/environmentControl/WorkerForks") {}

interface Batch {
  readonly id: string;
  readonly leaseId: string;
  readonly key: string;
  readonly jobs: Array<FleetForkJobState>;
  readonly done: Deferred.Deferred<void>;
  readonly start: Effect.Effect<void>;
  finishedAt: number | null;
}

/**
 * Slots handed out first come, first served. Effect's Semaphore wakes its waiters on a later tick,
 * so a batch that frees a slot and asks again at once keeps it ahead of another batch's job that
 * was already waiting. Here a freed slot goes straight to the oldest waiter. Waiting can always be
 * interrupted, even where the work itself cannot be, so a host shutting down never waits its turn.
 */
const makeSlots = (initial: number) => {
  let size = initial;
  let used = 0;
  const waiting = new Set<Deferred.Deferred<void>>();
  const handOut = () => {
    for (const turn of waiting) {
      if (used >= size) return;
      waiting.delete(turn);
      used += 1;
      Deferred.doneUnsafe(turn, Effect.void);
    }
  };
  const free = () => {
    used -= 1;
    handOut();
  };
  return {
    resize: (next: number) =>
      Effect.sync(() => {
        size = next;
        handOut();
      }),
    withSlot: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (waiting.size === 0 && used < size) {
            used += 1;
            return Effect.void;
          }
          const turn = Deferred.makeUnsafe<void>();
          waiting.add(turn);
          // A slot handed over just as the wait is interrupted goes to the next waiter.
          return Effect.interruptible(Deferred.await(turn)).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                if (!waiting.delete(turn)) free();
              }),
            ),
          );
        }).pipe(Effect.andThen(restore(effect).pipe(Effect.ensuring(Effect.sync(free))))),
      ),
  };
};

/**
 * What a chat's running batches share: its copy slots (maxPerChat across all of them), and one
 * capture at a time, since a capture pauses the chat's machine and stashes its /tmp in one place.
 */
interface Chat {
  readonly copySlots: ReturnType<typeof makeSlots>;
  readonly captureLock: ReturnType<typeof makeSlots>;
}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const hasParentSegment = (path: string) => path.split("/").includes("..");

const view = (batch: Batch): FleetForkBatch => ({
  batchId: batch.id,
  state: batch.finishedAt === null ? "running" : "finished",
  jobs: [...batch.jobs],
});

const make = Effect.gen(function* () {
  const machines = yield* ForkMachines.ForkMachines;
  const crypto = yield* Crypto.Crypto;
  const host = (yield* (yield* ServerEnvironment.ServerEnvironment).getDescriptor).environmentId;
  const scope = yield* Effect.scope;
  const batches = new Map<string, Batch>();
  const hostSlots = makeSlots(forkLimits({}).maxPerHost);
  const chats = new Map<string, Chat>();
  const chatOf = (leaseId: string) => {
    let chat = chats.get(leaseId);
    if (chat === undefined) {
      chat = {
        copySlots: makeSlots(forkLimits({}).maxPerChat),
        captureLock: makeSlots(1),
      };
      chats.set(leaseId, chat);
    }
    return chat;
  };
  const runningBatches = (leaseId: string) =>
    [...batches.values()].filter((batch) => batch.leaseId === leaseId && batch.finishedAt === null);
  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, batch] of batches)
      if (batch.finishedAt !== null && now - batch.finishedAt > FINISHED_BATCH_TTL_MS)
        batches.delete(id);
    for (const leaseId of chats.keys())
      if (runningBatches(leaseId).length === 0) chats.delete(leaseId);
  });

  const runJob = (
    batch: Batch,
    source: Box,
    actor: FleetActor,
    input: FleetForkRunInput,
    limits: ForkLimits,
    captureId: string,
    index: number,
  ) => {
    const job = input.jobs[index]!;
    const cwd = job.cwd ?? source.projectDir ?? "/home/user";
    const timeoutMs = Math.min((job.timeoutSeconds ?? Infinity) * 1000, limits.maxJobMs);
    const tag = { host, batchId: batch.id, leaseId: source.leaseId };
    const fields = {
      leaseId: source.leaseId,
      threadId: actor.threadId,
      batchId: batch.id,
      job: index,
    };
    const outputs = job.outputs ?? [];
    const logStep = (error: ForkMachines.ForkMachineError) =>
      Effect.logWarning("worker fork step failed", {
        ...fields,
        step: error.step,
        cause: error.cause,
      });
    return Effect.acquireUseRelease(
      Effect.gen(function* () {
        const forkId = yield* machines
          .start(captureId, tag, Math.min(timeoutMs + AFTER_JOB_MS, MAX_LIFETIME_MS))
          .pipe(
            // A provider out of room for the moment usually has it again within seconds.
            Effect.retry({
              while: (error) => error.busy === true,
              schedule: Schedule.exponential("5 seconds"),
              times: 3,
            }),
          );
        batch.jobs[index] = { index, state: "running" };
        yield* Effect.logInfo("worker fork started", { ...fields, forkId });
        return { forkId, startedAt: yield* Clock.currentTimeMillis };
      }),
      ({ forkId, startedAt }) =>
        Effect.gen(function* () {
          const exit = yield* machines.run(forkId, { command: job.command, cwd, timeoutMs }).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs + RUN_GRACE_MS),
              orElse: () =>
                Effect.fail(
                  new ForkMachines.ForkMachineError({
                    step: "run",
                    cause: new Error("The copy stopped answering"),
                  }),
                ),
            }),
          );
          const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
          const problems: Array<string> = [];
          let logsUri: string | undefined;
          let outputsUri: string | undefined;
          let copiedTo: string | undefined;
          if (limits.outputsUri !== undefined) {
            const uri = `${limits.outputsUri}/${source.environmentId}/${batch.id}/${index}/`;
            const uploaded = yield* machines
              .upload(forkId, { cwd, paths: outputs, uri })
              .pipe(Effect.tapError(logStep), Effect.option);
            if (Option.isNone(uploaded)) problems.push("Uploading the logs and outputs failed.");
            else if (uploaded.value.kind === "no_credentials")
              problems.push(
                `Nothing was uploaded: this chat's ${uploaded.value.unresolved.join(", ")} could not be read from its machine's secret store.`,
              );
            else {
              logsUri = `${uri}logs/`;
              if (outputs.length > 0) outputsUri = `${uri}outputs/`;
              if (uploaded.value.missing.length > 0)
                problems.push(`Not found: ${uploaded.value.missing.join(", ")}.`);
            }
          } else if (outputs.length > 0 && input.copyBack !== true) {
            problems.push("This host has no outputs bucket; pass copyBack:true to keep outputs.");
          }
          if (input.copyBack === true && outputs.length > 0) {
            const destination = `${RESULTS_ROOT}/${batch.id}/job-${index}`;
            const copied = yield* machines
              .copyBack(forkId, {
                sourceSandboxId: source.sandboxId,
                cwd,
                paths: outputs,
                destination,
                maxBytes: limits.maxCopyBackBytes,
              })
              .pipe(Effect.tapError(logStep), Effect.option);
            if (Option.isNone(copied)) problems.push("Copying the outputs back failed.");
            else if (copied.value.kind === "copied") copiedTo = destination;
            else if (copied.value.kind === "asleep")
              problems.push("This chat's machine was asleep, so outputs were not copied back.");
            else
              problems.push(
                `The outputs are ${Math.ceil(copied.value.bytes / 1048576)} MiB compressed, over the ${Math.floor(limits.maxCopyBackBytes / 1048576)} MiB copy-back limit.`,
              );
          }
          batch.jobs[index] = {
            index,
            state: "exited",
            ...exit,
            durationMs,
            ...(logsUri === undefined ? {} : { logsUri }),
            ...(outputsUri === undefined ? {} : { outputsUri }),
            ...(copiedTo === undefined ? {} : { copiedTo }),
            ...(problems.length === 0 ? {} : { outputsProblem: problems.join(" ") }),
          };
        }),
      ({ forkId, startedAt }) =>
        Effect.gen(function* () {
          yield* machines.kill(forkId);
          yield* Effect.logInfo("worker fork stopped", {
            ...fields,
            forkId,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          });
        }),
    ).pipe(
      Effect.catchTags({
        ForkMachineError: (error) =>
          Effect.sync(() => {
            batch.jobs[index] = { index, state: "failed", message: error.message };
          }).pipe(Effect.andThen(logStep(error))),
      }),
    );
  };

  const runBatch = (
    batch: Batch,
    source: Box,
    actor: FleetActor,
    input: FleetForkRunInput,
    limits: ForkLimits,
  ) =>
    Effect.gen(function* () {
      yield* hostSlots.resize(limits.maxPerHost);
      const chat = chatOf(source.leaseId);
      yield* chat.copySlots.resize(limits.maxPerChat);
      const tag = { host, batchId: batch.id, leaseId: source.leaseId };
      // At its end a batch deletes its capture and sweeps its tag, which also removes a copy whose
      // start answer was lost. Whatever fails here is left for the next periodic sweep.
      const cleanUp = (captureId: string) =>
        machines
          .sweep(host, (batchId) => batchId === batch.id)
          .pipe(
            Effect.tap(({ forks }) =>
              forks === 0
                ? Effect.void
                : Effect.logWarning("removed worker forks a batch lost track of", {
                    batchId: batch.id,
                    forks,
                  }),
            ),
            Effect.andThen(machines.release(captureId)),
            Effect.catch((error) =>
              Effect.logWarning("a worker fork batch could not clean up; the next sweep retries", {
                batchId: batch.id,
                step: error.step,
              }),
            ),
          );
      yield* Effect.acquireUseRelease(
        chat.captureLock.withSlot(machines.capture(source.sandboxId, tag)),
        (captureId) =>
          Effect.forEach(
            input.jobs.map((_, index) => index),
            // Every job takes its chat's slot before the host's, so no two jobs wait on each other.
            (index) =>
              chat.copySlots.withSlot(
                hostSlots.withSlot(runJob(batch, source, actor, input, limits, captureId, index)),
              ),
            {
              concurrency: Math.min(input.concurrency ?? limits.maxPerChat, limits.maxPerChat),
              discard: true,
            },
          ),
        cleanUp,
      ).pipe(
        Effect.catchTags({
          ForkMachineError: (error) =>
            Effect.sync(() => {
              for (const [index, job] of batch.jobs.entries())
                if (job.state === "queued")
                  batch.jobs[index] = { index, state: "failed", message: error.message };
            }),
        }),
      );
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          batch.finishedAt = yield* Clock.currentTimeMillis;
          yield* Deferred.succeed(batch.done, undefined);
        }),
      ),
    );

  /** Waits up to `budget` for the batch to finish, then reports it. */
  const answer = (batch: Batch, budget: Duration.Duration) =>
    Deferred.await(batch.done).pipe(
      Effect.timeoutOption(budget),
      Effect.map(() => view(batch)),
    );

  const run: WorkerForks["Service"]["run"] = (source, actor, input) =>
    Effect.gen(function* () {
      if (source.provider !== "e2b")
        return yield* failure(
          "capability_denied",
          "t3_fork_run is not supported on Mac machines yet; it runs on cloud sandbox chats.",
        );
      for (const job of input.jobs) {
        if (job.cwd !== undefined && !job.cwd.startsWith("/"))
          return yield* failure("invalid_request", "A job's cwd must be an absolute path.");
        if ((job.outputs ?? []).some(hasParentSegment))
          return yield* failure("invalid_request", "Output paths cannot contain '..'.");
      }
      const settings = yield* machines.settings.pipe(
        Effect.mapError(() =>
          failure("environment_unavailable", "The host could not read its cloud settings."),
        ),
      );
      if (settings === null)
        return yield* failure("environment_unavailable", "This host has no cloud configuration.");
      const limits = forkLimits(settings);
      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const done = yield* Deferred.make<void>();
      yield* prune;
      // A retried call while its batch runs joins it rather than paying for a second one. Nothing
      // yields from this check until the new batch is recorded, so two calls cannot both miss.
      const key = encodeKey(input);
      const running = runningBatches(source.leaseId);
      const same = running.find((batch) => batch.key === key);
      if (same !== undefined) return { batch: view(same), start: same.start };
      if (running.length >= MAX_RUNNING_BATCHES_PER_CHAT)
        return yield* failure(
          "invalid_request",
          `This chat already has ${running.length} fork batches running (${running.map((batch) => batch.id).join(", ")}). Wait for one with t3_fork_status, then start the next.`,
        );
      let started = false;
      const batch: Batch = {
        id,
        leaseId: source.leaseId,
        key,
        jobs: input.jobs.map((_, index) => ({ index, state: "queued" as const })),
        done,
        start: Effect.suspend(() => {
          if (started) return Effect.void;
          started = true;
          return runBatch(batch, source, actor, input, limits).pipe(
            Effect.forkIn(scope),
            Effect.asVoid,
          );
        }),
        finishedAt: null,
      };
      batches.set(batch.id, batch);
      return { batch: view(batch), start: batch.start };
    });

  const status: WorkerForks["Service"]["status"] = (source, input) =>
    Effect.gen(function* () {
      yield* prune;
      const batch = batches.get(input.batchId);
      if (batch === undefined || batch.leaseId !== source.leaseId)
        return yield* failure(
          "invalid_request",
          `No fork batch ${input.batchId} for this chat. Finished batches are kept six hours, and a host restart ends running ones.`,
        );
      return yield* answer(batch, Duration.seconds(input.waitSeconds ?? 0));
    });

  return WorkerForks.of({
    run,
    status,
    sweep: Effect.suspend(() => {
      const live = new Set(
        [...batches.values()].filter((batch) => batch.finishedAt === null).map((batch) => batch.id),
      );
      return machines.sweep(host, (batchId) => !live.has(batchId));
    }).pipe(
      Effect.tap(({ forks, captures, failed }) =>
        forks + captures === 0
          ? Effect.void
          : Effect.logInfo("removed worker forks no running batch owns", {
              forks,
              captures,
              failed,
            }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("worker forks could not be swept", { cause: error.cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(WorkerForks, make);
