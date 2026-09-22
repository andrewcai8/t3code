import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentRegistryModule from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as EnvironmentSupervisorModule from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import { workspaceMissingError } from "../connection/errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { runAtomCommand } from "./runtime.ts";
import { threadKey } from "./entities.ts";
import {
  isOfflineThreadLifecycleDispatchResult,
  threadLifecycleOverlayAtom,
} from "./threadLifecycleOverlay.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const NOW = "2026-09-12T10:00:00.000Z";
const SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  updatedAt: NOW,
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Remote thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    },
  ],
};

const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* () {
  const requests = yield* Queue.unbounded<{
    command: ClientOrchestrationCommand;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<{ sequence: number }, Error>();
              yield* Queue.offer(requests, { command, reply });
              return yield* Deferred.await(reply);
            }),
        },
      } as unknown as RpcSession.RpcSession),
    ),
  } as EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  return { registry, commands, snapshotAtom, visibleAtom, requests };
});

describe("remote thread lifecycle commands", () => {
  const actions = [
    ["settle", {}, { settledOverride: "settled", pinnedAt: null, snoozedUntil: null }],
    ["unsettle", { reason: "user" }, { settledOverride: "active", settledAt: null }],
    [
      "snooze",
      { snoozedUntil: "2099-01-01T00:00:00.000Z" },
      { snoozedUntil: "2099-01-01T00:00:00.000Z" },
    ],
    ["unsnooze", { reason: "user" }, { snoozedUntil: null, snoozedAt: null }],
    ["pin", { orderKey: "a" }, { pinnedAt: expect.any(String), pinOrderKey: "a" }],
    ["unpin", {}, { pinnedAt: null, pinOrderKey: null }],
    ["reorderPin", { orderKey: "b" }, { pinOrderKey: "b" }],
    ["reorderActive", { orderKey: "b" }, { activeOrderKey: "b" }],
  ] as const;

  for (const [action, input, expected] of actions) {
    it.effect(`shows ${action} before a delayed remote reply and rolls back a rejection`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const source = h.snapshotAtom(ENVIRONMENT_ID);
        const initial = {
          ...SNAPSHOT,
          threads: [
            {
              ...SNAPSHOT.threads[0]!,
              ...(action === "unsettle" || action === "pin"
                ? { settledOverride: "settled" as const, settledAt: NOW }
                : {}),
              ...(action === "unsnooze" || action === "settle" || action === "pin"
                ? { snoozedUntil: "2099-01-01T00:00:00.000Z", snoozedAt: NOW }
                : {}),
              ...(action === "unpin" || action === "settle"
                ? { pinnedAt: NOW, pinOrderKey: "a" }
                : {}),
            },
          ],
        };
        h.registry.set(source, initial);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            commandId: CommandId.make(action),
            reason: "user",
            orderKey: "a",
            snoozedUntil: "2099-01-01T00:00:00.000Z",
            ...input,
          },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(expected);
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(source)).toBe(initial);
        yield* Deferred.fail(request.reply, new Error("Remote rejected the action"));
        expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(initial);
      }),
    );
  }

  it.effect("keeps the preview after acknowledgement until the matching shell update arrives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, title: "Renamed remotely" }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({
        title: "Renamed remotely",
        settledOverride: "settled",
      });
      const confirmed = {
        ...changed,
        snapshotSequence: 3,
        threads: [
          {
            ...changed.threads[0]!,
            settledOverride: "settled" as const,
            settledAt: "2026-09-12T12:00:00.000Z",
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 4 });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBeNull();
    }),
  );

  it.effect(
    "shows a queued reverse action immediately and preserves it if the earlier action fails",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const settle = h.commands.settle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        });
        const first = yield* Queue.take(h.requests);
        const unsettle = h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        yield* Deferred.fail(first.reply, new Error("Settle rejected"));
        yield* Effect.promise(() => settle);
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe("thread.unsettle");
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "active" as const }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(second.reply, { sequence: 2 });
        yield* Effect.promise(() => unsettle);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("isolates environments and does not restore a remotely removed thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const otherEnvironment = EnvironmentId.make("other-remote");
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.commands.snapshotAtom(otherEnvironment))).toBe(SNAPSHOT);
      const removed = { ...SNAPSHOT, snapshotSequence: 2, threads: [] };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), removed);
      expect(h.registry.get(h.visibleAtom)?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("Thread removed"));
      yield* Effect.promise(() => result);
      expect(h.registry.get(h.visibleAtom)).toBe(removed);
    }),
  );

  it.effect("keeps pending approvals visible while a lifecycle request is pending", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const blocked = {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, hasPendingApprovals: true }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), blocked);
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(blocked.threads[0]);
      yield* Deferred.fail(request.reply, new Error("Approval pending"));
      yield* Effect.promise(() => result);
    }),
  );

  for (const action of ["settle", "snooze"] as const) {
    it.effect(`restores a confirmed ${action} when a queued undo fails`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const parked =
          action === "settle"
            ? { settledOverride: "settled" as const }
            : { snoozedUntil: "2099-01-01T00:00:00.000Z" };
        const awake = action === "settle" ? { settledOverride: "active" } : { snoozedUntil: null };
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const first = yield* Queue.take(h.requests);
        const undo = h.commands[action === "settle" ? "unsettle" : "unsnooze"].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
        yield* Deferred.succeed(first.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, ...parked }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe(
          action === "settle" ? "thread.unsettle" : "thread.unsnooze",
        );
        yield* Deferred.fail(second.reply, new Error("Undo rejected"));
        expect((yield* Effect.promise(() => undo))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
    );

    it.effect(`preserves a newer approval when the ${action} reply arrives after the shell`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        const newer = {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, hasPendingApprovals: true }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), newer);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)).toBe(newer);
      }),
    );

    it.effect(`shows an accepted ${action} while the shell still has an old input request`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const stale = {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, hasPendingUserInput: true }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), stale);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(stale.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(
          action === "settle"
            ? { settledOverride: "settled" }
            : { snoozedUntil: "2099-01-01T00:00:00.000Z" },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.hasPendingUserInput).toBe(false);
        expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(stale);
      }),
    );
  }
});

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const OFFLINE_ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const OFFLINE_THREAD_ID = ThreadId.make("thread-1");
const OFFLINE_TARGET = new PrimaryConnectionTarget({
  environmentId: OFFLINE_ENVIRONMENT_ID,
  label: "kmar33fuo01bi",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

class ThreadStillWorkingError extends Schema.TaggedError<ThreadStillWorkingError>()(
  "ThreadStillWorkingError",
  {
    message: Schema.String,
  },
) {}

const makeOfflineHarness = Effect.fn("makeOfflineHarness")(function* (
  input: {
    readonly run?: EnvironmentRegistryModule.EnvironmentRegistry["Service"]["run"];
  } = {},
) {
  const supervisor = EnvironmentSupervisorModule.EnvironmentSupervisor.of({
    target: OFFLINE_TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none()),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisorModule.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistryModule.EnvironmentRegistry["Service"]["run"] =
    input.run ??
    ((_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisorModule.EnvironmentSupervisor, supervisor));
  const environmentRegistry = EnvironmentRegistryModule.EnvironmentRegistry.of({
    run,
    followStream: (
      _environmentId: typeof OFFLINE_ENVIRONMENT_ID,
      stream: Stream.Stream<unknown, unknown, unknown>,
    ) =>
      Stream.provideService(stream, EnvironmentSupervisorModule.EnvironmentSupervisor, supervisor),
  } as unknown as EnvironmentRegistryModule.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistryModule.EnvironmentRegistry, environmentRegistry),
      TEST_CRYPTO_LAYER,
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationShellSnapshot | null>(null),
  );
  return {
    commands: createThreadEnvironmentAtoms(runtime, snapshotAtom),
    registry: AtomRegistry.make(),
  };
});

const failingRun = <E>(error: E): EnvironmentRegistryModule.EnvironmentRegistry["Service"]["run"] =>
  (() => Effect.fail(error)) as EnvironmentRegistryModule.EnvironmentRegistry["Service"]["run"];

describe("offline thread.settle", () => {
  it.effect("parks the thread locally when the environment has no RPC session", () =>
    Effect.gen(function* () {
      const harness = yield* makeOfflineHarness();
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.settle, {
          environmentId: OFFLINE_ENVIRONMENT_ID,
          input: { threadId: OFFLINE_THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(
        harness.registry
          .get(threadLifecycleOverlayAtom)
          .get(threadKey({ environmentId: OFFLINE_ENVIRONMENT_ID, threadId: OFFLINE_THREAD_ID }))
          ?.kind,
      ).toBe("settled");
    }),
  );

  it.effect("parks the thread locally when the environment is not registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeOfflineHarness({
        run: failingRun(
          new EnvironmentRegistryModule.EnvironmentNotRegisteredError({
            environmentId: OFFLINE_ENVIRONMENT_ID,
          }),
        ),
      });
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.settle, {
          environmentId: OFFLINE_ENVIRONMENT_ID,
          input: { threadId: OFFLINE_THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(
        harness.registry
          .get(threadLifecycleOverlayAtom)
          .get(threadKey({ environmentId: OFFLINE_ENVIRONMENT_ID, threadId: OFFLINE_THREAD_ID }))
          ?.kind,
      ).toBe("settled");
    }),
  );

  it.effect("still reports business-logic settle failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeOfflineHarness({
        run: failingRun(new ThreadStillWorkingError({ message: "Thread is still working." })),
      });
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.settle, {
          environmentId: OFFLINE_ENVIRONMENT_ID,
          input: { threadId: OFFLINE_THREAD_ID },
        }),
      );

      expect(AsyncResult.isFailure(result)).toBe(true);
      expect(harness.registry.get(threadLifecycleOverlayAtom).size).toBe(0);
    }),
  );
});

describe("offline thread.delete", () => {
  const key = threadKey({ environmentId: OFFLINE_ENVIRONMENT_ID, threadId: OFFLINE_THREAD_ID });

  it.effect("deletes the thread on this device when the environment has no RPC session", () =>
    Effect.gen(function* () {
      const harness = yield* makeOfflineHarness();
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.delete, {
          environmentId: OFFLINE_ENVIRONMENT_ID,
          input: { threadId: OFFLINE_THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(harness.registry.get(threadLifecycleOverlayAtom).get(key)?.kind).toBe("deleted");
    }),
  );

  it.effect("deletes the thread on this device when its workspace no longer exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeOfflineHarness({ run: failingRun(workspaceMissingError()) });
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.delete, {
          environmentId: OFFLINE_ENVIRONMENT_ID,
          input: { threadId: OFFLINE_THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(harness.registry.get(threadLifecycleOverlayAtom).get(key)?.kind).toBe("deleted");
    }),
  );
});
