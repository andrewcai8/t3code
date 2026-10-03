import { describe, it, assert } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeManagedServerProvider } from "./makeManagedServerProvider.ts";
import { ProviderCheckPermits } from "./providerCheckPermits.ts";

const snapshot = (status: ServerProvider["status"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status,
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
});

const TestLayer = Layer.mergeAll(
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(true),
    streamChanges: Stream.empty,
  }),
  ServerSettings.layerTest(),
  TestClock.layer(),
);

describe("provider check permits", () => {
  it.effect("runs a bounded number of checks at once and times each one only after it starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const running = yield* Ref.make(0);
        const peakRunning = yield* Ref.make(0);
        // Each check takes 3s against a 4s timeout. With 2 permits and 6
        // instances, the third wave waits 6s in line before it starts.
        const checkProvider = Ref.updateAndGet(running, (count) => count + 1).pipe(
          Effect.flatMap((count) => Ref.update(peakRunning, (peak) => Math.max(peak, count))),
          Effect.andThen(Effect.sleep("3 seconds")),
          Effect.ensuring(Ref.update(running, (count) => count - 1)),
          Effect.timeoutOption("4 seconds"),
          Effect.map(
            Option.match({ onNone: () => snapshot("error"), onSome: () => snapshot("ready") }),
          ),
        );
        const providers = yield* Effect.forEach(Array.from({ length: 6 }), () =>
          makeManagedServerProvider<{ readonly enabled: boolean }>({
            resolveMaintenance: () =>
              Effect.succeed({
                provider: ProviderDriverKind.make("codex"),
                packageName: "@openai/codex",
                update: null,
              }),
            getSettings: Effect.succeed({ enabled: true }),
            streamSettings: Stream.empty,
            haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
            initialSnapshot: () => Effect.succeed(snapshot("warning")),
            checkProvider,
            refreshInterval: "1 hour",
          }),
        );
        const runWaves = Effect.fn(function* <A>(fiber: Fiber.Fiber<A>) {
          for (let wave = 0; wave < 3; wave++) {
            yield* TestClock.adjust("3 seconds");
          }
          return yield* Fiber.join(fiber);
        });

        const bootChecks = yield* Effect.forEach(
          providers,
          (provider) =>
            Stream.take(provider.streamChanges, 1).pipe(
              Stream.runHead,
              Effect.map(Option.map((published) => published.status)),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(
          yield* runWaves(bootChecks),
          Array.from({ length: 6 }, () => Option.some("ready")),
        );
        assert.strictEqual(yield* Ref.get(peakRunning), 2);

        const refreshAll = yield* Effect.forEach(
          providers,
          (provider) => provider.refresh.pipe(Effect.map((published) => published.status)),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        assert.deepStrictEqual(
          yield* runWaves(refreshAll),
          Array.from({ length: 6 }, () => "ready"),
        );
        assert.strictEqual(yield* Ref.get(peakRunning), 2);
      }),
    ).pipe(
      Effect.provideService(ProviderCheckPermits, Semaphore.makeUnsafe(2)),
      Effect.provide(TestLayer),
    ),
  );
});
