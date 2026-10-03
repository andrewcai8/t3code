import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProvisionedChat,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { HostChat } from "../connection/hostBoxSync.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { type EnvironmentShellState, makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const HOST_ID = EnvironmentId.make("host-1");

const CHAT_PROJECT: OrchestrationProjectShell = {
  ...v2Project,
  id: ProjectId.make("project-cloud"),
  title: "t3code",
  workspaceRoot: "/workspace/t3code",
};
const CHAT_THREAD: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  id: ThreadId.make("thread-cloud-chat"),
  projectId: CHAT_PROJECT.id,
  title: "Fix the flaky test",
};

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  generation: 1,
};

const EMPTY_CACHE = {
  loadShell: () => Effect.succeedNone,
  saveShell: () => Effect.void,
  loadThread: () => Effect.succeedNone,
  saveThread: () => Effect.void,
  removeThread: () => Effect.void,
  loadServerConfig: () => Effect.succeedNone,
  saveServerConfig: () => Effect.void,
  loadVcsRefs: () => Effect.succeedNone,
  saveVcsRefs: () => Effect.void,
  removeVcsRefs: () => Effect.void,
  clearVcsRefs: () => Effect.void,
  clear: () => Effect.void,
} satisfies Persistence.EnvironmentCacheStore["Service"];

const LIVE_SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const registryWith = (
  hostChats: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, HostChat>>,
) =>
  EnvironmentRegistry.EnvironmentRegistry.of({
    hostChats,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);

/** The host lists a newer read of this box's chat. */
const offerChat = (
  hostChats: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, HostChat>>,
  chat: ProvisionedChat,
) =>
  SubscriptionRef.set(hostChats, new Map([[TARGET.environmentId, { managerId: HOST_ID, chat }]]));

describe("cloud box shell synchronization", () => {
  it.effect(
    "a box's shell takes its host's newer read of the chat until its own stream is live",
    () =>
      Effect.gen(function* () {
        const hostChats = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, HostChat>>(
          new Map(),
        );
        const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
        } as unknown as WsRpcProtocolClient;
        const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
          AVAILABLE_CONNECTION_STATE,
        );
        const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.none(),
        );
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: supervisorState,
          session: activeSession,
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registryWith(hostChats)),
          Effect.provideService(
            Persistence.EnvironmentCacheStore,
            Persistence.EnvironmentCacheStore.of({
              ...EMPTY_CACHE,
              loadShell: () => Effect.succeedSome(LIVE_SHELL_SNAPSHOT),
            }),
          ),
          Effect.provideService(
            ShellSnapshotLoader.ShellSnapshotLoader,
            ShellSnapshotLoader.ShellSnapshotLoader.of({ load: () => Effect.succeedNone }),
          ),
        );
        const snapshotAt = (sequence: number) =>
          SubscriptionRef.changes(shellState).pipe(
            Stream.filter((state) =>
              Option.exists(state.snapshot, (snapshot) => snapshot.snapshotSequence === sequence),
            ),
            Stream.runHead,
            Effect.map((state) => Option.getOrThrow(state)),
          );

        yield* offerChat(hostChats, { sequence: 4, project: CHAT_PROJECT, thread: CHAT_THREAD });
        const adopted = yield* snapshotAt(4);
        expect([adopted.status, Option.getOrThrow(adopted.snapshot)]).toEqual([
          "cached",
          {
            ...LIVE_SHELL_SNAPSHOT,
            snapshotSequence: 4,
            projects: [v2Project, CHAT_PROJECT],
            threads: [v2ThreadShell, CHAT_THREAD],
          },
        ]);

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        yield* SubscriptionRef.set(supervisorState, CONNECTED_STATE);
        yield* Queue.offerAll(events, [
          { kind: "snapshot", snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 10 } },
          { kind: "synchronized" },
        ]);
        yield* SubscriptionRef.changes(shellState).pipe(
          Stream.filter((state) => state.status === "live"),
          Stream.runHead,
        );
        yield* offerChat(hostChats, { sequence: 12, project: CHAT_PROJECT, thread: CHAT_THREAD });
        for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
        const live = yield* SubscriptionRef.get(shellState);
        expect([live.status, Option.getOrThrow(live.snapshot).snapshotSequence]).toEqual([
          "live",
          10,
        ]);
      }),
  );

  it.effect(
    "a host chat taken after a failed subscription makes the retry reload instead of resuming past it",
    () =>
      Effect.gen(function* () {
        const hostChats = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, HostChat>>(
          new Map(),
        );
        const failNow = yield* Deferred.make<void>();
        const resubscribed = yield* Deferred.make<void>();
        const afterSequences = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: {
            readonly afterSequence?: number;
          }) =>
            Stream.unwrap(
              Ref.modify(
                afterSequences,
                (seen) => [seen.length, [...seen, input.afterSequence]] as const,
              ).pipe(
                Effect.flatMap((call): Effect.Effect<Stream.Stream<never, Error>> =>
                  call === 0
                    ? Effect.succeed(
                        Stream.fromEffect(Deferred.await(failNow)).pipe(
                          Stream.flatMap(() =>
                            Stream.fail(new Error("The shell projection failed.")),
                          ),
                        ),
                      )
                    : Deferred.succeed(resubscribed, undefined).pipe(Effect.as(Stream.never)),
                ),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make<SupervisorConnectionState>(CONNECTED_STATE),
          session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
            Option.some(session(client)),
          ),
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const loads = yield* Ref.make(0);
        const shellState = yield* makeEnvironmentShellState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(EnvironmentRegistry.EnvironmentRegistry, registryWith(hostChats)),
          Effect.provideService(
            Persistence.EnvironmentCacheStore,
            Persistence.EnvironmentCacheStore.of(EMPTY_CACHE),
          ),
          Effect.provideService(
            ShellSnapshotLoader.ShellSnapshotLoader,
            ShellSnapshotLoader.ShellSnapshotLoader.of({
              load: () =>
                Ref.updateAndGet(loads, (count) => count + 1).pipe(
                  Effect.map((count) =>
                    Option.some({ ...LIVE_SHELL_SNAPSHOT, snapshotSequence: count * 10 }),
                  ),
                ),
            }),
          ),
        );
        const settle = (predicate: (state: EnvironmentShellState) => boolean) =>
          SubscriptionRef.changes(shellState).pipe(Stream.filter(predicate), Stream.runHead);

        yield* settle((state) =>
          Option.exists(state.snapshot, (shell) => shell.snapshotSequence === 10),
        );
        yield* Deferred.succeed(failNow, undefined);
        yield* settle((state) => state.status === "cached" && Option.isSome(state.error));
        yield* offerChat(hostChats, { sequence: 50, project: CHAT_PROJECT, thread: CHAT_THREAD });
        yield* settle((state) =>
          Option.exists(state.snapshot, (shell) => shell.snapshotSequence === 50),
        );
        // The retry runs 250 ms after the failure, on the same session.
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(resubscribed);

        expect(yield* Ref.get(afterSequences)).toEqual([10, 20]);
      }),
  );
});
