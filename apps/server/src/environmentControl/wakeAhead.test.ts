import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  type CloudMachineKind,
  type DiscoveredProvisionedEnvironment,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { ownerChat } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";
import { makeWakeAhead, planWakeAhead } from "./wakeAhead.ts";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

const box = (
  name: string,
  input: {
    readonly lifecycle?: "active" | "paused";
    readonly machine?: CloudMachineKind;
    readonly thread?: Record<string, unknown> | null;
    readonly expiresAt?: string;
  } = {},
): DiscoveredProvisionedEnvironment => {
  const chat =
    input.thread === null
      ? null
      : ownerChat(
          boxShell([boxThread(`thread-${name}`, "project-app", name, input.thread)]),
          `thread-${name}`,
        );
  return {
    requestId: `request-${name}` as DiscoveredProvisionedEnvironment["requestId"],
    leaseId: `lease-${name}`,
    sandboxId: `sandbox-${name}`,
    lifecycle: input.lifecycle ?? "paused",
    environmentId: EnvironmentId.make(name),
    provider: input.machine === "mac" || input.machine === "devbox" ? "namespace" : "e2b",
    machine: input.machine ?? "sandbox",
    label: name,
    repository: null,
    threadId: ThreadId.make(`thread-${name}`),
    createdAt: "2026-09-30T10:00:00.000Z",
    expiresAt: input.expiresAt ?? "2026-10-01T13:00:00.000Z",
    ...(chat ? { chat } : {}),
  };
};

const names = (boxes: ReadonlyArray<DiscoveredProvisionedEnvironment>) =>
  boxes.map((candidate) => candidate.environmentId);

const plan = (
  boxes: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  state: {
    readonly inFlight?: ReadonlyArray<readonly [string, CloudMachineKind]>;
    readonly retryAt?: ReadonlyArray<readonly [string, number]>;
  } = {},
) => {
  const result = planWakeAhead(boxes, {
    now: NOW,
    inFlight: new Map(
      (state.inFlight ?? []).map(([name, machine]) => [EnvironmentId.make(name), machine]),
    ),
    retryAt: new Map(state.retryAt ?? []),
  });
  return { wake: names(result.wake), renew: names(result.renew) };
};

it("wakes every paused unsettled chat, most recently active first, and no settled one", () => {
  expect(
    plan([
      box("older", { thread: { updatedAt: "2026-10-01T09:00:00.000Z" } }),
      box("settled", {
        thread: { settledOverride: "settled", settledAt: "2026-10-01T10:00:00.000Z" },
      }),
      box("archived", { thread: { archivedAt: "2026-10-01T10:00:00.000Z" } }),
      box("snoozed", { thread: { snoozedUntil: "2026-10-01T15:00:00.000Z" } }),
      box("snooze-over", { thread: { snoozedUntil: "2026-10-01T11:00:00.000Z" } }),
      box("unread", { thread: null }),
      box("newer", { thread: { updatedAt: "2026-10-01T11:30:00.000Z" } }),
      box("awake", { lifecycle: "active" }),
    ]).wake,
  ).toEqual(["newer", "older", "snooze-over"]);
});

it("keeps at most twenty wakes in flight, counting ones already running", () => {
  const paused = Array.from({ length: 25 }, (_, index) =>
    box(`box-${String(index).padStart(2, "0")}`, {
      thread: { updatedAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - index * 60_000)) },
    }),
  );
  expect(plan(paused).wake).toHaveLength(20);
  expect(plan(paused, { inFlight: [["opened-elsewhere", "sandbox"]] }).wake.at(-1)).toBe("box-18");
  expect(plan(paused, { inFlight: [["box-00", "sandbox"]] }).wake.slice(0, 2)).toEqual([
    "box-01",
    "box-02",
  ]);
});

it("leaves a box refused recently until its backoff passes", () => {
  const boxes = [box("refused"), box("fine")];
  expect(plan(boxes, { retryAt: [["lease-refused", NOW + 30_000]] }).wake).toEqual(["fine"]);
  expect(plan(boxes, { retryAt: [["lease-refused", NOW - 1]] }).wake).toEqual(["refused", "fine"]);
});

it("wakes one Mac at a time, and only while a Mac slot stays free after it", () => {
  const macs = [
    box("mac-a", { machine: "mac", thread: { updatedAt: "2026-10-01T11:00:00.000Z" } }),
    box("mac-b", { machine: "mac", thread: { updatedAt: "2026-10-01T10:00:00.000Z" } }),
  ];
  const awakeMac = (name: string) =>
    box(name, { machine: "mac", lifecycle: "active", thread: { settledOverride: "settled" } });
  expect(plan(macs).wake).toEqual(["mac-a"]);
  expect(plan([...macs, awakeMac("live-1")]).wake).toEqual(["mac-a"]);
  expect(plan([...macs, awakeMac("live-1"), awakeMac("live-2")]).wake).toEqual(["mac-a"]);
  expect(plan([...macs, awakeMac("live-1"), awakeMac("live-2"), awakeMac("live-3")]).wake).toEqual(
    [],
  );
  expect(plan(macs, { inFlight: [["opened", "mac"]] }).wake).toEqual([]);
  expect(plan([...macs, box("sandbox")]).wake).toEqual(["mac-a", "sandbox"]);
});

it("renews awake unsettled chats whose lease ends within ten minutes", () => {
  expect(
    plan([
      box("ending", { lifecycle: "active", expiresAt: "2026-10-01T12:05:00.000Z" }),
      box("later", { lifecycle: "active", expiresAt: "2026-10-01T12:30:00.000Z" }),
      box("settled-ending", {
        lifecycle: "active",
        expiresAt: "2026-10-01T12:05:00.000Z",
        thread: { settledOverride: "settled" },
      }),
    ]).renew,
  ).toEqual(["ending"]);
});

it.effect(
  "wakes a present user's two unsettled chats, not the settled one, and reports each machine",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      let boxes = [
        box("first"),
        box("second", { thread: { updatedAt: "2026-10-01T11:00:00.000Z" } }),
        box("settled", { thread: { settledOverride: "settled" } }),
      ];
      const resumed: Array<string> = [];
      const release = yield* Deferred.make<void>();
      const wakeAhead = makeWakeAhead({
        list: Effect.sync(() => boxes),
        resume: (target) =>
          Effect.sync(() => resumed.push(target.environmentId)).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                boxes = boxes.map((candidate) =>
                  candidate.environmentId === target.environmentId
                    ? { ...candidate, lifecycle: "active" as const }
                    : candidate,
                );
                return { kind: "resumed" as const };
              }),
            ),
          ),
        renew: () => Effect.void,
        scope: yield* Effect.scope,
      });

      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [
          { environmentId: "first", state: "asleep", machine: "sandbox" },
          { environmentId: "second", state: "asleep", machine: "sandbox" },
          { environmentId: "settled", state: "asleep", machine: "sandbox" },
        ],
      });
      expect(resumed).toEqual([]);
      expect(yield* wakeAhead.presence(true)).toEqual({
        machines: [
          { environmentId: "second", state: "waking", machine: "sandbox" },
          { environmentId: "first", state: "waking", machine: "sandbox" },
          { environmentId: "settled", state: "asleep", machine: "sandbox" },
        ],
      });
      expect(resumed).toEqual(["second", "first"]);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [{ environmentId: "settled", state: "asleep", machine: "sandbox" }],
      });
    }).pipe(Effect.scoped),
);
it.effect(
  "retries a refused wake after its backoff while the user stays, and stops once they leave",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const attempts: Array<number> = [];
      const wakeAhead = makeWakeAhead({
        list: Effect.succeed([box("crowded")]),
        resume: () =>
          Effect.sync(() => {
            attempts.push(attempts.length);
            return {
              kind: "refused",
              reason: "unknown",
              message: "E2B can't place this machine right now. Retrying.",
            } as const;
          }),
        renew: () => Effect.void,
        scope: yield* Effect.scope,
      });
      const tick = wakeAhead.pass.pipe(Effect.andThen(Effect.yieldNow));
      yield* wakeAhead.presence(true);
      yield* Effect.yieldNow;
      expect(attempts).toHaveLength(1);
      yield* TestClock.adjust("20 seconds");
      yield* tick;
      expect(attempts).toHaveLength(1);
      yield* TestClock.adjust("15 seconds");
      yield* tick;
      expect(attempts).toHaveLength(2);
      yield* TestClock.adjust("10 minutes");
      yield* tick;
      expect(attempts).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect("tracks an upgrade as updating over a wake of the same machine", () =>
  Effect.gen(function* () {
    const wakeAhead = makeWakeAhead({
      list: Effect.succeed([]),
      resume: () => Effect.succeed({ kind: "resumed" }),
      renew: () => Effect.void,
      scope: yield* Effect.scope,
    });
    const upgrade = yield* Deferred.make<void>();
    const fiber = yield* Deferred.await(upgrade).pipe(
      wakeAhead.track(EnvironmentId.make("box"), "sandbox", "updating"),
      wakeAhead.track(EnvironmentId.make("box"), "sandbox", "waking"),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    expect(yield* wakeAhead.presence(false)).toEqual({
      machines: [{ environmentId: "box", state: "updating", machine: "sandbox" }],
    });
    yield* Deferred.succeed(upgrade, undefined);
    yield* Fiber.join(fiber);
    expect(yield* wakeAhead.presence(false)).toEqual({ machines: [] });
  }).pipe(Effect.scoped),
);

it.effect(
  "says when a machine's provider last could not start it, until a wake answers otherwise",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const wakeAhead = makeWakeAhead({
        list: Effect.succeed([box("crowded")]),
        resume: () => Effect.succeed({ kind: "resumed" }),
        renew: () => Effect.void,
        scope: yield* Effect.scope,
      });
      yield* wakeAhead.settle(EnvironmentId.make("crowded"), {
        kind: "refused",
        reason: "unknown",
        cause: "provider-unavailable",
        message: "E2B couldn't start this machine yet. The problem is on E2B's side.",
      });
      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [
          {
            environmentId: "crowded",
            state: "asleep",
            machine: "sandbox",
            providerUnavailableAt: "2026-10-01T12:00:00.000Z",
          },
        ],
      });
      yield* wakeAhead.settle(EnvironmentId.make("crowded"), {
        kind: "refused",
        reason: "unknown",
        message: "The workspace could not be reconnected. Retry shortly.",
      });
      expect(yield* wakeAhead.presence(false)).toEqual({
        machines: [{ environmentId: "crowded", state: "asleep", machine: "sandbox" }],
      });
    }).pipe(Effect.scoped),
);
