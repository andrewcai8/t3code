import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type DiscoveredProvisionedEnvironment,
  EnvironmentId,
  type FleetForkRunInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ForkMachines from "./ForkMachines.ts";
import * as WorkerForks from "./WorkerForks.ts";

const owner = ThreadId.make("chat-1");
const actor = { environmentId: EnvironmentId.make("box-1"), threadId: owner };

/** Box 1 as the host records it: an E2B machine owned by chat-1. */
const box = (overrides: { readonly provider?: "e2b" | "namespace" } = {}) =>
  ({
    leaseId: "lease-1",
    environmentId: "box-1",
    sandboxId: "sandbox-1",
    provider: overrides.provider ?? "e2b",
    projectDir: "/home/user/work/app",
    threadId: owner,
  }) as unknown as DiscoveredProvisionedEnvironment;

/**
 * A provider where copies live until killed. A job's command picks its outcome: `exit N` exits
 * N, `hang` times out, `lose` loses its copy, `wait` holds until `gate` opens. Output paths
 * starting with `big` are over any copy-back cap; `gone` does not exist.
 */
const provider = (settings: ForkMachines.WorkerForkSettings = {}) =>
  Effect.gen(function* () {
    const live = new Map<string, ForkMachines.ForkTag>();
    const kills: Array<string> = [];
    const captures: Array<string> = [];
    const stored = new Map<string, { readonly host: string; readonly batchId: string }>();
    const copied: Array<{ readonly forkId: string; readonly destination: string }> = [];
    const entered = yield* Queue.unbounded<string>();
    const gate = yield* Deferred.make<void>();
    let started = 0;
    let running = 0;
    let mostRunning = 0;
    let providerWorks = true;
    let loseStartAnswer = false;
    const machines = ForkMachines.ForkMachines.of({
      settings: Effect.succeed(settings),
      capture: (sandboxId, tag) =>
        Effect.sync(() => {
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
        Effect.suspend(() => {
          started += 1;
          const forkId = `fork-${started}`;
          live.set(forkId, tag);
          return loseStartAnswer
            ? Effect.fail(new ForkMachines.ForkMachineError({ step: "start", cause: "timed out" }))
            : Effect.succeed(forkId);
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
      upload: (_forkId, input) =>
        Effect.succeed({ missing: input.paths.filter((path) => path.startsWith("gone")) }),
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
      entered,
      gate,
      loseStartAnswers: () => {
        loseStartAnswer = true;
      },
      breakProvider: (works: boolean) => {
        providerWorks = works;
      },
      mostRunning: () => mostRunning,
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
            outputsUri: `${prefix}/0/`,
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
            outputsUri: `${prefix}/1/`,
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
            outputsUri: `${prefix}/3/`,
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

it.effect("runs one batch per chat: another waits for it, the same one joins it", () =>
  withForks({}, (fake) =>
    Effect.gen(function* () {
      const first = yield* run({ jobs: [{ command: "wait" }] }).pipe(Effect.forkChild);
      yield* Queue.take(fake.entered);
      const other = yield* run({ jobs: [{ command: "exit 0" }] }).pipe(Effect.flip);
      expect(other.code).toBe("invalid_request");
      expect(other.message).toMatch(/^This chat already has fork batch .+ running\./);
      yield* Deferred.succeed(fake.gate, undefined);
      yield* Fiber.join(first);
      expect(fake.captures).toHaveLength(1);
    }),
  ),
);
