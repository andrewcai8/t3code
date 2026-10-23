import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

/**
 * Every parked fiber, so shutdown can stop this background work before it saves restart
 * state. Left to their layers, the loops would keep polling Git, pull requests, and the
 * database until shutdown reached those layers, last.
 */
export class ParkedWork extends Context.Reference<FiberSet.FiberSet<unknown, unknown> | undefined>(
  "t3/serverActivation/parkedWork",
  { defaultValue: () => undefined },
) {}

export const forkParkedFiber = Effect.fn("serverActivation.forkParkedFiber")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.fn.Return<Fiber.Fiber<A, E>, never, Scope.Scope | R> {
  const activation = yield* ServerActivation;
  const parkedWork = yield* ParkedWork;
  if (activation === undefined) {
    const fiber = yield* Effect.forkScoped(effect);
    if (parkedWork !== undefined) yield* FiberSet.add(parkedWork, fiber);
    return fiber;
  }
  const parked = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkScoped(
    Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
  );
  if (parkedWork !== undefined) yield* FiberSet.add(parkedWork, fiber);
  yield* Deferred.await(parked);
  return fiber;
});

export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);
