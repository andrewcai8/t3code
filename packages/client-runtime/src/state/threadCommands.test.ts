import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { workspaceMissingError } from "../connection/errors.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import { runAtomCommand } from "./runtime.ts";
import { threadKey } from "./entities.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import {
  isOfflineThreadLifecycleDispatchResult,
  threadLifecycleOverlayAtom,
} from "./threadLifecycleOverlay.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
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

const makeHarness = Effect.fn("makeHarness")(function* (
  input: {
    readonly run?: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"];
  } = {},
) {
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none()),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] =
    input.run ??
    ((_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream: (
      _environmentId: typeof ENVIRONMENT_ID,
      stream: Stream.Stream<unknown, unknown, unknown>,
    ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      TEST_CRYPTO_LAYER,
    ),
  );
  return {
    commands: createThreadEnvironmentAtoms(runtime),
    registry: AtomRegistry.make(),
  };
});

const failingRun = <E>(error: E): EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] =>
  (() => Effect.fail(error)) as EnvironmentRegistry.EnvironmentRegistry["Service"]["run"];

describe("offline thread.settle", () => {
  it.effect("parks the thread locally when the environment has no RPC session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.settle, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(
        harness.registry
          .get(threadLifecycleOverlayAtom)
          .get(threadKey({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }))?.kind,
      ).toBe("settled");
    }),
  );

  it.effect("parks the thread locally when the environment is not registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        run: failingRun(
          new EnvironmentRegistry.EnvironmentNotRegisteredError({
            environmentId: ENVIRONMENT_ID,
          }),
        ),
      });
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.settle, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(
        harness.registry
          .get(threadLifecycleOverlayAtom)
          .get(threadKey({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID }))?.kind,
      ).toBe("settled");
    }),
  );

  it.effect("still reports business-logic settle failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        run: failingRun(new ThreadStillWorkingError({ message: "Thread is still working." })),
      });
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.settle, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        }),
      );

      expect(AsyncResult.isFailure(result)).toBe(true);
      expect(harness.registry.get(threadLifecycleOverlayAtom).size).toBe(0);
    }),
  );
});

describe("offline thread.delete", () => {
  const key = threadKey({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });

  it.effect("deletes the thread on this device when the environment has no RPC session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.delete, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
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
      const harness = yield* makeHarness({ run: failingRun(workspaceMissingError()) });
      const result = yield* Effect.promise(() =>
        runAtomCommand(harness.registry, harness.commands.delete, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        }),
      );

      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") return;
      expect(isOfflineThreadLifecycleDispatchResult(result.value)).toBe(true);
      expect(harness.registry.get(threadLifecycleOverlayAtom).get(key)?.kind).toBe("deleted");
    }),
  );
});
