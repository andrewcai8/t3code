import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type DiscoveredProvisionedEnvironment,
  EnvironmentId,
  type FleetForkRunInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ForkMachines from "./ForkMachines.ts";
import * as WorkerForks from "./WorkerForks.ts";

const owner = ThreadId.make("chat-1");
const actor = { environmentId: EnvironmentId.make("box-1"), threadId: owner };

/** Box 1 as the host records it: an E2B machine owned by chat-1. */
const box = (
  overrides: { readonly provider?: "e2b" | "namespace"; readonly leaseId?: string } = {},
) =>
  ({
    leaseId: overrides.leaseId ?? "lease-1",
    environmentId: "box-1",
    sandboxId: "sandbox-1",
    provider: overrides.provider ?? "e2b",
    projectDir: "/home/user/work/app",
    threadId: owner,
  }) as unknown as DiscoveredProvisionedEnvironment;

/**
 * A provider where copies live until killed. A job's command picks its outcome: `exit N` exits
 * N, `hang` times out, `lose` loses its copy, `wait` holds until `gate` opens. `holdStarts` makes
 * each copy's start wait on its gate. Output paths
 * starting with `big` are over any copy-back cap; `gone` does not exist.
 */
const provider = (settings: ForkMachines.WorkerForkSettings = {}) =>
  Effect.gen(function* () {
    const live = new Map<string, ForkMachines.ForkTag>();
    const kills: Array<string> = [];
    const captures: Array<string> = [];
    const stored = new Map<string, { readonly host: string; readonly batchId: string }>();
    const copied: Array<{ readonly forkId: string; readonly destination: string }> = [];
    const startedBatches: Array<string> = [];
    const entered = yield* Queue.unbounded<string>();
    const gate = yield* Deferred.make<void>();
    let started = 0;
    let running = 0;
    let mostRunning = 0;
    const capturesEntered = yield* Queue.unbounded<string>();
    let capturing = 0;
    let mostCapturing = 0;
    let captureGate: Deferred.Deferred<void> | null = null;
    const startsEntered = yield* Queue.unbounded<string>();
    let startGate: Deferred.Deferred<void> | null = null;
    let providerWorks = true;
    let loseStartAnswer = false;
    let busyStarts = 0;
    const machines = ForkMachines.ForkMachines.of({
      settings: Effect.succeed(settings),
      capture: (sandboxId, tag) =>
        Effect.gen(function* () {
          capturing += 1;
          mostCapturing = Math.max(mostCapturing, capturing);
          yield* Queue.offer(capturesEntered, tag.batchId);
          if (captureGate !== null) yield* Deferred.await(captureGate);
          capturing -= 1;
          captures.push(`${sandboxId}@${tag.batchId}`);
          const captureId = `capture-${captures.length}`;
          stored.set(captureId, { host: tag.host, batchId: tag.batchId });
          return captureId;
        }),
      release: (captureId) =>
        Effect.suspend(() =>
          providerWorks
            ? Effect.sync(() => void stored.delete(captureId))
            : Effect.fail(new ForkMachines.ForkMachineError({ step: "capture", cause: "busy" })),
        ),
      start: (_captureId, tag) =>
        Effect.gen(function* () {
          if (busyStarts > 0) {
            busyStarts -= 1;
            return yield* new ForkMachines.ForkMachineError({
              step: "start",
              cause: "no room",
              busy: true,
            });
          }
          if (startGate !== null) {
            yield* Queue.offer(startsEntered, tag.batchId);
            yield* Deferred.await(startGate);
          }
          started += 1;
          startedBatches.push(tag.batchId);
          const forkId = `fork-${started}`;
          live.set(forkId, tag);
          if (loseStartAnswer)
            return yield* new ForkMachines.ForkMachineError({ step: "start", cause: "timed out" });
          return forkId;
        }),
      run: (forkId, job) =>
        Effect.gen(function* () {
          running += 1;
          mostRunning = Math.max(mostRunning, running);
          yield* Queue.offer(entered, forkId);
          if (job.command === "wait") yield* Deferred.await(gate);
          running -= 1;
          if (job.command === "lose")
            return yield* new ForkMachines.ForkMachineError({ step: "run", cause: "lost" });
          const hang = job.command === "hang";
          return {
            exitCode: hang ? -9 : Number(job.command.replace("exit ", "")) || 0,
            timedOut: hang,
            stdoutTail: `ran in ${job.cwd} for at most ${job.timeoutMs}ms`,
            stderrTail: "",
          };
        }),
      // A job run in /sealed is on a machine whose AWS keys sit unreadable in its secret store.
      upload: (_forkId, input) =>
        Effect.succeed(
          input.cwd === "/sealed"
            ? {
                kind: "no_credentials" as const,
                unresolved: ["AWS_REGION", "AWS_SECRET_ACCESS_KEY"],
              }
            : {
                kind: "uploaded" as const,
                missing: input.paths.filter((path) => path.startsWith("gone")),
              },
        ),
      copyBack: (forkId, input) =>
        input.paths.some((path) => path.startsWith("big"))
          ? Effect.succeed({ kind: "too_large" as const, bytes: input.maxBytes + 1 })
          : Effect.sync(() => {
              copied.push({ forkId, destination: input.destination });
              return { kind: "copied" as const };
            }),
      kill: (forkId) =>
        Effect.sync(() => {
          kills.push(forkId);
          if (providerWorks) live.delete(forkId);
        }),
      sweep: (host, remove) =>
        Effect.sync(() => {
          if (!providerWorks) return { forks: 0, captures: 0, failed: 1 };
          const copies = [...live].filter(([, tag]) => tag.host === host && remove(tag.batchId));
          for (const [id] of copies) live.delete(id);
          const held = [...stored].filter(([, tag]) => tag.host === host && remove(tag.batchId));
          for (const [id] of held) stored.delete(id);
          return { forks: copies.length, captures: held.length, failed: 0 };
        }),
    });
    const layer = WorkerForks.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ForkMachines.ForkMachines, machines),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("host-a"),
            } as never),
          }),
          NodeCrypto.layer,
        ),
      ),
    );
    return {
      layer,
      live,
      kills,
      captures,
      stored,
      copied,
      startedBatches,
      entered,
      gate,
      loseStartAnswers: () => {
        loseStartAnswer = true;
      },
      busyFor: (starts: number) => {
        busyStarts = starts;
      },
      breakProvider: (works: boolean) => {
        providerWorks = works;
      },
      mostRunning: () => mostRunning,
      mostCapturing: () => mostCapturing,
      capturesEntered,
      holdCaptures: (gate: Deferred.Deferred<void>) => {
        captureGate = gate;
      },
      startsEntered,
      holdStarts: (gate: Deferred.Deferred<void>) => {
        startGate = gate;
      },
    };
  });

type Fake = Effect.Success<ReturnType<typeof provider>>;

/** Runs `body` against one WorkerForks over a fresh fake provider. */
const withForks = <A, E>(
  settings: ForkMachines.WorkerForkSettings,
  body: (fake: Fake) => Effect.Effect<A, E, WorkerForks.WorkerForks>,
) =>
  Effect.gen(function* () {
    const fake = yield* provider(settings);
    return yield* body(fake).pipe(Effect.provide(fake.layer));
  });

/** Reserves a batch, starts it as the host does once the chat has its id, and waits for it. */
const run = (input: FleetForkRunInput, source = box()) =>
  Effect.gen(function* () {
    const forks = yield* WorkerForks.WorkerForks;
    const { batch, start } = yield* forks.run(source, actor, input);
    yield* start;
    return yield* forks.status(source, { batchId: batch.batchId, waitSeconds: 45 });
  });

it.effect("reserves a batch without touching the chat's machine until it is started", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const { batch, start } = yield* forks.run(box(), actor, {
        jobs: [{ command: "exit 0" }, { command: "exit 2" }],
      });
      expect(batch).toEqual({
        batchId: batch.batchId,
        state: "running",
        jobs: [
          { index: 0, state: "queued" },
          { index: 1, state: "queued" },
        ],
      });
      expect(fake.captures).toEqual([]);
      yield* start;
      yield* start;
      const finished = yield* forks.status(box(), { batchId: batch.batchId, waitSeconds: 45 });
      expect(
        finished.jobs.map((job) => (job.state === "exited" ? job.exitCode : job.state)),
      ).toEqual([0, 2]);
      expect(fake.captures).toEqual([`sandbox-1@${batch.batchId}`]);
    }),
  ),
);

it.effect("runs each job in its own copy and removes every copy once, however it ended", () =>
  withForks({ outputsUri: "s3://traces/t3-agents/", maxJobMinutes: 10 }, (fake) =>
    Effect.gen(function* () {
      const batch = yield* run({
        jobs: [
          { command: "exit 0", outputs: ["report.json", "gone.txt"] },
          { command: "exit 3", cwd: "/tmp" },
          { command: "lose" },
          { command: "hang", timeoutSeconds: 30 },
        ],
      });
      const prefix = `s3://traces/t3-agents/box-1/${batch.batchId}`;
      expect(batch).toEqual({
        batchId: batch.batchId,
        state: "finished",
        jobs: [
          {
            index: 0,
            state: "exited",
            exitCode: 0,
            timedOut: false,
            durationMs: 0,
            stdoutTail: "ran in /home/user/work/app for at most 600000ms",
            stderrTail: "",
            logsUri: `${prefix}/0/logs/`,
            outputsUri: `${prefix}/0/outputs/`,
            outputsProblem: "Not found: gone.txt.",
          },
          {
            index: 1,
            state: "exited",
            exitCode: 3,
            timedOut: false,
            durationMs: 0,
            stdoutTail: "ran in /tmp for at most 600000ms",
            stderrTail: "",
            logsUri: `${prefix}/1/logs/`,
          },
          {
            index: 2,
            state: "failed",
            message: "A copy of the chat's machine failed at its run step.",
          },
          {
            index: 3,
            state: "exited",
            exitCode: -9,
            timedOut: true,
            durationMs: 0,
            stdoutTail: "ran in /home/user/work/app for at most 30000ms",
            stderrTail: "",
            logsUri: `${prefix}/3/logs/`,
          },
        ],
      });
      expect(fake.kills.toSorted()).toEqual(["fork-1", "fork-2", "fork-3", "fork-4"]);
      expect(fake.live.size).toBe(0);
      expect(fake.captures).toEqual([`sandbox-1@${batch.batchId}`]);
      expect(fake.stored.size).toBe(0);
    }),
  ),
);

it.effect("says the chat's AWS keys could not be read instead of uploading without them", () =>
  withForks({ outputsUri: "s3://traces/t3-agents" }, () =>
    Effect.gen(function* () {
      const batch = yield* run({ jobs: [{ command: "exit 0", cwd: "/sealed", outputs: ["out"] }] });
      expect(batch.jobs[0]).toEqual({
        index: 0,
        state: "exited",
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "ran in /sealed for at most 7200000ms",
        stderrTail: "",
        outputsProblem:
          "Nothing was uploaded: this chat's AWS_REGION, AWS_SECRET_ACCESS_KEY could not be read from its machine's secret store.",
      });
    }),
  ),
);

it.effect("never runs more copies at once than the chat's limit", () =>
  withForks({ maxPerChat: 2 }, (fake) =>
    Effect.gen(function* () {
      const batch = yield* run({
        jobs: Array.from({ length: 5 }, () => ({ command: "wait" })),
        concurrency: 8,
      }).pipe(Effect.forkChild);
      yield* Queue.take(fake.entered);
      yield* Queue.take(fake.entered);
      yield* Deferred.succeed(fake.gate, undefined);
      const finished = yield* Fiber.join(batch);
      expect(finished.jobs.map((job) => job.state)).toEqual([
        "exited",
        "exited",
        "exited",
        "exited",
        "exited",
      ]);
      expect(fake.mostRunning()).toBe(2);
      expect(fake.kills).toHaveLength(5);
    }),
  ),
);

it.effect("copies outputs into the chat's machine only when asked, within the cap", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const kept = yield* run({
        jobs: [
          { command: "exit 0", outputs: ["dist"] },
          { command: "exit 0", outputs: ["big.tar"] },
        ],
        copyBack: true,
        concurrency: 1,
      });
      const left = yield* run({ jobs: [{ command: "exit 0", outputs: ["dist"] }] });
      expect(
        kept.jobs.map((job) =>
          job.state === "exited" ? [job.copiedTo, job.outputsProblem] : job.state,
        ),
      ).toEqual([
        [`/home/user/fork-results/${kept.batchId}/job-0`, undefined],
        [undefined, "The outputs are 101 MiB compressed, over the 100 MiB copy-back limit."],
      ]);
      expect(fake.copied).toEqual([
        { forkId: "fork-1", destination: `/home/user/fork-results/${kept.batchId}/job-0` },
      ]);
      expect(left.jobs[0]).toEqual({
        index: 0,
        state: "exited",
        exitCode: 0,
        timedOut: false,
        durationMs: 0,
        stdoutTail: "ran in /home/user/work/app for at most 7200000ms",
        stderrTail: "",
        outputsProblem: "This host has no outputs bucket; pass copyBack:true to keep outputs.",
      });
    }),
  ),
);

it.effect("refuses a Mac chat before copying anything", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const error = yield* run(
        { jobs: [{ command: "exit 0" }] },
        box({ provider: "namespace" }),
      ).pipe(Effect.flip);
      expect([error.code, error.message]).toEqual([
        "capability_denied",
        "t3_fork_run is not supported on Mac machines yet; it runs on cloud sandbox chats.",
      ]);
      expect(fake.captures).toEqual([]);
    }),
  ),
);

it.effect("joins a retried call to the batch it started, and reports it by id", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const input = { jobs: [{ command: "wait" }] };
      const first = yield* run(input).pipe(Effect.forkChild);
      yield* Queue.take(fake.entered);
      const retry = yield* run(input).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(fake.gate, undefined);
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(retry)];
      expect(b.batchId).toBe(a.batchId);
      expect(fake.captures).toHaveLength(1);
      const reported = yield* WorkerForks.WorkerForks.pipe(
        Effect.flatMap((forks) => forks.status(box(), { batchId: a.batchId })),
      );
      expect(reported.state).toBe("finished");
    }),
  ),
);

it.effect("removes a copy whose start answer was lost when its batch ends", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      fake.loseStartAnswers();
      const batch = yield* run({ jobs: [{ command: "exit 0" }] });
      expect(batch.jobs).toEqual([
        {
          index: 0,
          state: "failed",
          message: "A copy of the chat's machine failed at its start step.",
        },
      ]);
      expect(fake.kills).toEqual([]);
      expect(fake.live.size).toBe(0);
    }),
  ),
);

it.effect("starts a copy once the provider has room again after asking for a retry", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      fake.busyFor(2);
      const batch = yield* run({ jobs: [{ command: "exit 0" }] }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const finished = yield* Fiber.join(batch);
      expect(finished.jobs.map((job) => job.state)).toEqual(["exited"]);
      expect(fake.live.size).toBe(0);
    }),
  ),
);

it.effect("sweeps what batches left behind, sparing a running batch and other hosts", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      fake.breakProvider(false);
      fake.live.set("fork-other", { host: "host-b", batchId: "b", leaseId: "lease-9" });
      yield* run({ jobs: [{ command: "exit 0" }, { command: "exit 0" }] });
      expect([...fake.live.keys()].toSorted()).toEqual(["fork-1", "fork-2", "fork-other"]);
      expect([...fake.stored.keys()]).toEqual(["capture-1"]);
      fake.breakProvider(true);
      const busy = yield* run({ jobs: [{ command: "wait" }] }).pipe(Effect.forkChild);
      while ((yield* Queue.take(fake.entered)) !== "fork-3");
      yield* WorkerForks.WorkerForks.pipe(Effect.flatMap((forks) => forks.sweep));
      expect([...fake.live.keys()].toSorted()).toEqual(["fork-3", "fork-other"]);
      expect([...fake.stored.keys()]).toEqual(["capture-2"]);
      yield* Deferred.succeed(fake.gate, undefined);
      yield* Fiber.join(busy);
      expect([...fake.live.keys()]).toEqual(["fork-other"]);
      expect(fake.stored.size).toBe(0);
    }),
  ),
);

it.effect("runs a short batch while a long one is still going, and joins a retried one", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const long = yield* forks.run(box(), actor, { jobs: [{ command: "wait" }] });
      yield* long.start;
      yield* Queue.take(fake.entered);
      const short = yield* run({ jobs: [{ command: "exit 0" }] });
      expect([short.state, short.jobs.map((job) => job.state)]).toEqual(["finished", ["exited"]]);
      const retried = yield* forks.run(box(), actor, { jobs: [{ command: "wait" }] });
      expect(retried.batch.batchId).toBe(long.batch.batchId);
      yield* Deferred.succeed(fake.gate, undefined);
      const finished = yield* forks.status(box(), {
        batchId: long.batch.batchId,
        waitSeconds: 45,
      });
      expect(finished.state).toBe("finished");
      expect(fake.captures).toEqual([
        `sandbox-1@${long.batch.batchId}`,
        `sandbox-1@${short.batchId}`,
      ]);
    }),
  ),
);

it.effect("holds a chat's copy limit across its batches, and captures them one at a time", () =>
  withForks({ maxPerChat: 2 }, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const captured = yield* Deferred.make<void>();
      fake.holdCaptures(captured);
      const twoWaits = [{ command: "wait" }, { command: "wait" }];
      const first = yield* forks.run(box(), actor, { jobs: twoWaits });
      const second = yield* forks.run(box(), actor, { jobs: twoWaits, concurrency: 2 });
      yield* first.start;
      yield* second.start;
      yield* Queue.take(fake.capturesEntered);
      yield* Deferred.succeed(captured, undefined);
      yield* Queue.take(fake.capturesEntered);
      yield* Queue.take(fake.entered);
      yield* Queue.take(fake.entered);
      yield* Deferred.succeed(fake.gate, undefined);
      const batches = yield* Effect.forEach([first, second], ({ batch }) =>
        forks.status(box(), { batchId: batch.batchId, waitSeconds: 45 }),
      );
      expect(batches.flatMap((batch) => batch.jobs.map((job) => job.state))).toEqual([
        "exited",
        "exited",
        "exited",
        "exited",
      ]);
      expect(fake.mostRunning()).toBe(2);
      expect(fake.captures).toHaveLength(2);
      expect(fake.mostCapturing()).toBe(1);
    }),
  ),
);

it.effect("refuses a fifth running batch for one chat, naming the four it has", () =>
  withForks({}, () =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const reserved = yield* Effect.forEach([0, 1, 2, 3], (code) =>
        forks.run(box(), actor, { jobs: [{ command: `exit ${code}` }] }),
      );
      const ids = reserved.map(({ batch }) => batch.batchId);
      const fifth = yield* forks
        .run(box(), actor, { jobs: [{ command: "exit 4" }] })
        .pipe(Effect.flip);
      expect([fifth.code, fifth.message]).toEqual([
        "invalid_request",
        `This chat already has 4 fork batches running (${ids.join(", ")}). Wait for one with t3_fork_status, then start the next.`,
      ]);
      const retried = yield* forks.run(box(), actor, { jobs: [{ command: "exit 2" }] });
      expect(retried.batch.batchId).toBe(ids[2]);
    }),
  ),
);

it.effect("hands a freed copy slot to the batch that waited longest", () =>
  withForks({ maxPerChat: 1 }, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const long = yield* forks.run(box(), actor, {
        jobs: [
          { command: "wait" },
          { command: "exit 1" },
          { command: "exit 2" },
          { command: "exit 3" },
        ],
      });
      yield* long.start;
      yield* Queue.take(fake.entered);
      const short = yield* forks.run(box(), actor, { jobs: [{ command: "exit 0" }] });
      yield* short.start;
      yield* Queue.take(fake.capturesEntered);
      yield* Queue.take(fake.capturesEntered);
      // Lets the short batch's job reach the slot queue before the long batch's first job ends.
      yield* Effect.yieldNow;
      yield* Deferred.succeed(fake.gate, undefined);
      yield* forks.status(box(), { batchId: long.batch.batchId, waitSeconds: 45 });
      const [a, b] = [long.batch.batchId, short.batch.batchId];
      expect(fake.startedBatches).toEqual([a, b, a, a, a]);
    }),
  ),
);

it.effect("skips a snapshot still waiting its turn when the host shuts down", () =>
  Effect.gen(function* () {
    const fake = yield* provider();
    const captured = yield* Deferred.make<void>();
    fake.holdCaptures(captured);
    const host = yield* Scope.make();
    const forks = Context.get(
      yield* Layer.buildWithScope(fake.layer, host),
      WorkerForks.WorkerForks,
    );
    const first = yield* forks.run(box(), actor, { jobs: [{ command: "exit 0" }] });
    const second = yield* forks.run(box(), actor, { jobs: [{ command: "exit 1" }] });
    yield* first.start;
    yield* Queue.take(fake.capturesEntered);
    yield* second.start;
    // Lets the second batch reach the snapshot queue before the host shuts down.
    yield* Effect.yieldNow;
    const closing = yield* Scope.close(host, Exit.void).pipe(Effect.forkChild);
    const skipped = yield* forks.status(box(), { batchId: second.batch.batchId, waitSeconds: 45 });
    yield* Deferred.succeed(captured, undefined);
    yield* Fiber.join(closing);
    expect(skipped).toEqual({
      batchId: second.batch.batchId,
      state: "finished",
      jobs: [{ index: 0, state: "queued" }],
    });
    expect(fake.captures).toEqual([`sandbox-1@${first.batch.batchId}`]);
    expect(fake.stored.size).toBe(0);
  }),
);

it.effect("cancels a queued job so it never starts, and lets the running one finish", () =>
  withForks({ maxPerChat: 1 }, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const { batch, start } = yield* forks.run(box(), actor, {
        jobs: [{ command: "wait" }, { command: "exit 0" }],
      });
      yield* start;
      yield* Queue.take(fake.entered);
      const cancelled = yield* forks.cancel(box(), { batchId: batch.batchId, jobs: [1] });
      expect(cancelled.jobs).toEqual([
        { index: 0, state: "running" },
        { index: 1, state: "cancelled" },
      ]);
      yield* Deferred.succeed(fake.gate, undefined);
      const finished = yield* forks.status(box(), { batchId: batch.batchId, waitSeconds: 45 });
      expect([finished.state, finished.jobs.map((job) => job.state)]).toEqual([
        "finished",
        ["exited", "cancelled"],
      ]);
      expect(fake.startedBatches).toEqual([batch.batchId]);
      expect(fake.kills).toEqual(["fork-1"]);
    }),
  ),
);

it.effect("keeps a job cancelled while its copy is starting, then kills that copy once", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const starting = yield* Deferred.make<void>();
      fake.holdStarts(starting);
      const { batch, start } = yield* forks.run(box(), actor, { jobs: [{ command: "exit 0" }] });
      yield* start;
      yield* Queue.take(fake.startsEntered);
      yield* forks.cancel(box(), { batchId: batch.batchId });
      yield* Deferred.succeed(starting, undefined);
      const ended = yield* forks.status(box(), { batchId: batch.batchId, waitSeconds: 45 });
      expect(ended).toEqual({
        batchId: batch.batchId,
        state: "finished",
        jobs: [{ index: 0, state: "cancelled" }],
      });
      expect(fake.kills).toEqual(["fork-1"]);
      expect(fake.live.size).toBe(0);
      expect(fake.stored.size).toBe(0);
    }),
  ),
);

it.effect("kills a cancelled job's copy once and gives its slot to the next batch", () =>
  withForks({ maxPerChat: 1 }, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const stuck = yield* forks.run(box(), actor, { jobs: [{ command: "wait" }] });
      yield* stuck.start;
      yield* Queue.take(fake.entered);
      const next = yield* forks.run(box(), actor, { jobs: [{ command: "exit 0" }] });
      yield* next.start;
      yield* Queue.take(fake.capturesEntered);
      yield* Queue.take(fake.capturesEntered);
      yield* forks.cancel(box(), { batchId: stuck.batch.batchId, jobs: [0] });
      const ended = yield* forks.status(box(), {
        batchId: stuck.batch.batchId,
        waitSeconds: 45,
      });
      expect(ended).toEqual({
        batchId: stuck.batch.batchId,
        state: "finished",
        jobs: [{ index: 0, state: "cancelled" }],
      });
      const ran = yield* forks.status(box(), { batchId: next.batch.batchId, waitSeconds: 45 });
      expect(ran.jobs.map((job) => job.state)).toEqual(["exited"]);
      expect(fake.kills).toEqual(["fork-1", "fork-2"]);
      expect(fake.live.size).toBe(0);
      expect(fake.stored.size).toBe(0);
    }),
  ),
);

it.effect("cancels a whole batch, and a second cancel changes nothing", () =>
  withForks({ maxPerChat: 2 }, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const { batch, start } = yield* forks.run(box(), actor, {
        jobs: [{ command: "wait" }, { command: "wait" }, { command: "exit 0" }],
      });
      yield* start;
      yield* Queue.take(fake.entered);
      yield* Queue.take(fake.entered);
      yield* forks.cancel(box(), { batchId: batch.batchId });
      const ended = yield* forks.status(box(), { batchId: batch.batchId, waitSeconds: 45 });
      const expected = {
        batchId: batch.batchId,
        state: "finished",
        jobs: [
          { index: 0, state: "cancelled" },
          { index: 1, state: "cancelled" },
          { index: 2, state: "cancelled" },
        ],
      };
      expect(ended).toEqual(expected);
      expect(yield* forks.cancel(box(), { batchId: batch.batchId })).toEqual(expected);
      expect(fake.kills.toSorted()).toEqual(["fork-1", "fork-2"]);
      expect(fake.live.size).toBe(0);
      expect(fake.stored.size).toBe(0);
    }),
  ),
);

it.effect("leaves a finished job as it ended when it is cancelled", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const finished = yield* run({ jobs: [{ command: "exit 3" }] });
      const cancelled = yield* forks.cancel(box(), { batchId: finished.batchId, jobs: [0] });
      expect(cancelled).toEqual(finished);
      expect(cancelled.jobs.map((job) => (job.state === "exited" ? job.exitCode : -1))).toEqual([
        3,
      ]);
      expect(fake.kills).toEqual(["fork-1"]);
    }),
  ),
);

it.effect("refuses to cancel another chat's batch", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const forks = yield* WorkerForks.WorkerForks;
      const { batch, start } = yield* forks.run(box(), actor, { jobs: [{ command: "wait" }] });
      yield* start;
      yield* Queue.take(fake.entered);
      const error = yield* forks
        .cancel(box({ leaseId: "lease-2" }), { batchId: batch.batchId })
        .pipe(Effect.flip);
      expect([error.code, error.message]).toEqual([
        "invalid_request",
        `No fork batch ${batch.batchId} for this chat. Finished batches are kept six hours, and a host restart ends running ones.`,
      ]);
      yield* Deferred.succeed(fake.gate, undefined);
      const finished = yield* forks.status(box(), { batchId: batch.batchId, waitSeconds: 45 });
      expect(finished.jobs.map((job) => job.state)).toEqual(["exited"]);
    }),
  ),
);
