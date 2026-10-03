import type { ProvisionedChat } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { withHostChat } from "../connection/hostBoxSync.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentShellState } from "./shell.ts";

/**
 * The state a box's shell takes from its host's newer read of the box's chat, or null to keep its
 * own. Only a shell whose own stream is not running takes one; a live or synchronizing stream is
 * the box itself and outranks any copy.
 */
function adoptHostChat(
  current: EnvironmentShellState,
  chat: ProvisionedChat,
): EnvironmentShellState | null {
  if (current.status === "live" || current.status === "synchronizing") return null;
  const snapshot = withHostChat(current.snapshot, chat);
  return snapshot === null
    ? null
    : { snapshot: Option.some(snapshot), status: "cached", error: current.error };
}

/**
 * Feeds a box's shell its chat as its host lists it in the registry: the shell takes each newer
 * one while it is not live. Does nothing without a registry in context.
 */
export const followHostChat = Effect.fn("EnvironmentShellState.followHostChat")(function* (
  state: SubscriptionRef.SubscriptionRef<EnvironmentShellState>,
  lastAuthoritativeSession: Ref.Ref<RpcSession | null>,
) {
  const registry = yield* Effect.serviceOption(EnvironmentRegistry.EnvironmentRegistry);
  if (Option.isNone(registry)) return;
  const environmentId = (yield* EnvironmentSupervisor.EnvironmentSupervisor).target.environmentId;
  // Re-checked as the status settles, so a chat that arrives while the shell starts is kept.
  yield* SubscriptionRef.changes(registry.value.hostChats).pipe(
    Stream.map((held) => held.get(environmentId)?.chat),
    Stream.filter(Predicate.isNotUndefined),
    Stream.changesWith((left, right) => left.sequence === right.sequence),
    Stream.zipLatest(
      SubscriptionRef.changes(state).pipe(
        Stream.map(({ status }) => status),
        Stream.changes,
      ),
    ),
    Stream.runForEach(([chat]) =>
      Effect.gen(function* () {
        if (adoptHostChat(yield* SubscriptionRef.get(state), chat) === null) return;
        // The copy's sequence is no cursor. Resuming from it on the same session would skip the
        // box's other events, so the next subscription reloads the snapshot. Cleared first, so
        // no subscription can read the copy's sequence as its own.
        yield* Ref.set(lastAuthoritativeSession, null);
        yield* SubscriptionRef.update(state, (current) => adoptHostChat(current, chat) ?? current);
      }),
    ),
    Effect.forkScoped,
  );
});
