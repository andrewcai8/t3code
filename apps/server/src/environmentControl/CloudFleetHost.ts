/**
 * CloudFleetHost - plays the desktop window's part for the host's cloud boxes.
 *
 * Every cloud chat runs on its own box with its own T3 server. The host holds
 * each box's broker token, so it registers with every awake box as that box's
 * fleet host (see home/FleetBroker.ts) and offers the user's other cloud chats
 * as environments, each with its stored chat card. A request a box relays runs
 * on its target box with that box's token: the host wakes a sleeping target
 * first, and answers a thread list for one from its card instead. One more
 * environment starts a new cloud chat through the same provisioning a client
 * uses. Boxes never hold a host credential; the host decides what each sees.
 *
 * @module CloudFleetHost
 */
import {
  CLOUD_FORKS_ENVIRONMENT_ID,
  type DiscoveredProvisionedEnvironment,
  defaultInstanceIdForDriver,
  EnvironmentId,
  type FleetActor,
  type FleetEnvironment,
  type FleetHostRegistration,
  type FleetHostRequest,
  type FleetHostResponse,
  type FleetInput,
  type FleetInvokeInput,
  type FleetResult,
  FleetResults,
  MessageId,
  OrchestratorMcpFailure,
  ProvisionRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { listThreadPage } from "../home/FleetService.ts";
import { CHANGES_STATE } from "../mcp/homeRouting.ts";
import * as BoxFleetClient from "./BoxFleetClient.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";
import { listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { createProvisionedLeaseRegistry, type RemoteAccess } from "./ProvisionedLeaseRegistry.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import * as WorkerForks from "./WorkerForks.ts";

/** The environment every box is offered for starting a chat on a fresh cloud machine. */
export const NEW_CLOUD_CHAT_ENVIRONMENT_ID = EnvironmentId.make("cloud:new-chat");

/**
 * Every chat the host starts for another chat has an id that starts with this and names the
 * starting chat's lease. Such a chat cannot start more, and one chat keeps at most
 * MAX_STARTED_CHATS of them, so an agent cannot fan out paid machines without a person.
 */
const STARTED_CHAT_PREFIX = "cloud-started:";
const MAX_STARTED_CHATS = 4;

const RECONCILE_INTERVAL = Duration.seconds(15);
const FORK_SWEEP_INTERVAL = Duration.minutes(10);
// A box that will not hold a connection, such as one on a build without the fleet RPCs, is tried
// again after 15 s, doubling up to 10 minutes; a connection that lasts a pass resets it.
const RETRY_FIRST_MS = 15_000;
const RETRY_MAX_MS = 10 * 60_000;
// A box gives up on a relayed call after 90 seconds. The host answers first, and once a wake or
// launch has used RELAY_DEADLINE it says so rather than acting, so a late answer never makes the
// agent repeat a change that went through.
const WAKE_BUDGET = Duration.seconds(45);
const LAUNCH_BUDGET = Duration.seconds(50);
const RELAY_DEADLINE_MS = 55_000;
const FOLLOW_UP_BUDGET = Duration.seconds(20);

export class CloudFleetHost extends Context.Service<
  CloudFleetHost,
  {
    /**
     * Registers with every awake cloud chat's box, again when what it would offer changes, and
     * lets go of boxes that slept or left. A box with a call in flight keeps its registration
     * until the call ends, because a new registration fails the box's pending calls.
     */
    readonly reconcile: Effect.Effect<void>;
    /**
     * Reconciles now and on an interval, for the life of the scope, and on another removes the
     * worker forks no running batch owns, starting with those an earlier run left behind.
     */
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/environmentControl/CloudFleetHost") {}

type Box = DiscoveredProvisionedEnvironment;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const unavailable = (message: string) => failure("environment_unavailable", message);

const boxName = (box: Box) => box.chat?.thread.title ?? box.label;

const startedBy = (box: Box) => `${STARTED_CHAT_PREFIX}${box.leaseId}:`;
const canStartChats = (box: Box) => !box.threadId?.startsWith(STARTED_CHAT_PREFIX);

/**
 * What one box is offered: every other cloud chat, a new one unless a chat started it, and
 * copies of its own machine for t3_fork_run.
 */
function registrationFor(source: Box, boxes: ReadonlyArray<Box>): FleetHostRegistration {
  const siblings = boxes
    .filter((box) => box.environmentId !== source.environmentId)
    .map((box): FleetEnvironment => {
      const thread = box.chat?.thread;
      return {
        environmentId: box.environmentId,
        label: boxName(box),
        connected: box.lifecycle !== "missing",
        ...(thread === undefined
          ? {}
          : {
              chat: {
                threadId: thread.id,
                title: thread.title,
                status: thread.activityRunStatus ?? thread.status,
                updatedAt: DateTime.formatIso(thread.updatedAt),
              },
            }),
      };
    });
  return {
    clientId: "t3-cloud-host",
    environments: [
      ...siblings,
      ...(canStartChats(source)
        ? [
            {
              environmentId: NEW_CLOUD_CHAT_ENVIRONMENT_ID,
              label: "New cloud chat on a fresh machine",
              connected: true,
            },
          ]
        : []),
      {
        environmentId: CLOUD_FORKS_ENVIRONMENT_ID,
        label: "Throwaway copies of this machine, for t3_fork_run",
        connected: true,
      },
    ],
  };
}

const decodeThreadList = Schema.decodeUnknownEffect(FleetResults["threads.list"]);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Whether the box's chat may change things or wake machines, from the host's own card. */
const actsFully = (box: Box) =>
  box.chat?.thread.runtimeMode === "full-access" && box.chat.thread.interactionMode === "default";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentControl = yield* EnvironmentControl.EnvironmentControl;
  const operations = yield* ProvisionOperationStore;
  const boxClient = yield* BoxFleetClient.BoxFleetClient;
  const forks = yield* WorkerForks.WorkerForks;
  const crypto = yield* Crypto.Crypto;
  const leases = createProvisionedLeaseRegistry(sql);
  const connections = yield* FiberMap.make<string>();
  // Wakes and launches outlive the call that asked, so a retry joins the one in flight.
  const work = yield* FiberMap.make<string, unknown, unknown>();
  const registered = new Map<
    string,
    {
      readonly key: string;
      readonly registration: SubscriptionRef.SubscriptionRef<FleetHostRegistration>;
    }
  >();
  const inFlight = new Map<string, number>();
  const retries = new Map<string, { readonly failures: number; readonly retryAt: number }>();
  // The one launch each chat may have in flight, by what it asked for.
  const launching = new Map<string, string>();
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  /** Every cloud chat's box this host holds that is not removed. */
  const chatBoxes = listProvisionedEnvironments(sql, [], [], []).pipe(
    Effect.map((boxes) => boxes.filter((box) => box.threadId !== null)),
    Effect.mapError(() => unavailable("The host could not list its cloud chats.")),
  );

  /** A box's broker access, with its proxy served when it has one. */
  const accessOf = (leaseId: string) =>
    Effect.gen(function* () {
      const lease = yield* Effect.promise(() => leases.findById(leaseId).catch(() => null));
      if (lease?.remoteAccess === undefined) return null;
      yield* environmentControl.namespaceProxyOrigin(leaseId).pipe(Effect.ignore);
      return lease.remoteAccess;
    });

  const once = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
    Effect.withFiber((caller) => {
      const running = FiberMap.getUnsafe(work, key);
      if (Option.isSome(running)) return Effect.succeed(running.value as Fiber.Fiber<A, E>);
      const fiber = Effect.runForkWith(caller.context)(effect);
      FiberMap.setUnsafe(work, key, fiber);
      return Effect.succeed(fiber);
    });

  const claimLaunch = <A, E>(
    leaseId: string,
    asked: string,
    started: number,
    effect: Effect.Effect<A, E>,
  ) =>
    Effect.withFiber<Fiber.Fiber<A, E> | "busy" | "full">((caller) => {
      const running = FiberMap.getUnsafe(work, `launch:${leaseId}`);
      if (Option.isSome(running))
        return Effect.succeed(
          launching.get(leaseId) === asked ? (running.value as Fiber.Fiber<A, E>) : "busy",
        );
      if (started >= MAX_STARTED_CHATS) return Effect.succeed("full" as const);
      launching.set(leaseId, asked);
      const fiber = Effect.runForkWith(caller.context)(effect);
      FiberMap.setUnsafe(work, `launch:${leaseId}`, fiber);
      return Effect.succeed(fiber);
    });

  const invokeOn = (leaseId: string, name: string, invoke: FleetInvokeInput) =>
    Effect.gen(function* () {
      const access = yield* accessOf(leaseId);
      if (access === null) return yield* unavailable(`${name} cannot be reached.`);
      return yield* Effect.scoped(
        boxClient.open(access).pipe(Effect.flatMap((connection) => connection.invoke(invoke))),
      ).pipe(
        Effect.catchTags({
          BoxUnreachableError: () => Effect.fail(unavailable(`${name} could not be reached.`)),
        }),
      );
    });

  const wake = (target: Box) =>
    Effect.gen(function* () {
      const resume = yield* once(
        `wake:${target.environmentId}`,
        environmentControl.resume({ environmentId: target.environmentId }),
      );
      const woke = yield* Fiber.join(resume).pipe(
        Effect.timeoutOption(WAKE_BUDGET),
        Effect.mapError(() => unavailable(`${boxName(target)} could not be woken.`)),
      );
      if (Option.isNone(woke))
        return yield* unavailable(
          `${boxName(target)} is still waking up; a cloud Mac can take a few minutes. Try again shortly.`,
        );
      if (woke.value.kind === "refused") return yield* unavailable(woke.value.message);
    });

  const startChat = (
    source: Box | undefined,
    boxes: ReadonlyArray<Box>,
    actor: FleetActor,
    input: FleetInput<"threads.launch">,
  ) =>
    Effect.gen(function* () {
      const message = input.message;
      if (message === undefined)
        return yield* failure("invalid_request", "A new cloud chat needs a first message.");
      if (source === undefined || !canStartChats(source))
        return yield* failure(
          "capability_denied",
          "A cloud chat another chat started cannot start more.",
        );
      // Chats still being prepared count too, from the durable request, so a restart or a launch
      // that outlived its call cannot slip past the cap.
      const preparing = yield* operations.listUnresolved.pipe(
        Effect.mapError(() => unavailable("The host could not read its cloud chats.")),
      );
      const started = new Set([
        ...boxes
          .filter((box) => box.threadId?.startsWith(startedBy(source)))
          .map((box) => box.requestId),
        ...preparing
          .filter((operation) => operation.request.chat?.threadId.startsWith(startedBy(source)))
          .map((operation) => operation.request.requestId),
      ]).size;
      const origin = (yield* operations
        .get(source.requestId)
        .pipe(Effect.mapError(() => unavailable("The host could not read this chat's machine."))))
        .request;
      const modelSelection = input.modelSelection ?? source.chat?.thread.modelSelection;
      if (modelSelection === undefined)
        return yield* failure("invalid_request", "Pass modelSelection for the new chat.");
      // The new machine runs the same agent as this one, under its driver's default instance.
      if (
        origin.agentDriver !== undefined &&
        modelSelection.instanceId !== defaultInstanceIdForDriver(origin.agentDriver)
      )
        return yield* failure(
          "invalid_request",
          `A new cloud chat runs ${origin.agentDriver} like this one; pick one of its models.`,
        );
      const stillStarting = unavailable(
        `The new cloud chat "${input.title}" was started and is still getting its machine ready, which can take a few minutes. Do not launch it again; t3_environment_list shows it once it is ready.`,
      );
      const threadId = ThreadId.make(`${startedBy(source)}${yield* uuid}`);
      // A chat has one launch in flight: asking again for it joins it, asking for another
      // waits. Checked and claimed in one step, so two calls cannot both start a machine.
      const claim = yield* claimLaunch(
        source.leaseId,
        `${input.title}\u0000${message}`,
        started,
        Effect.gen(function* () {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          return yield* environmentControl.provision({
            requestId: ProvisionRequestId.make(yield* uuid),
            provider: origin.provider,
            providerInstanceId: origin.providerInstanceId,
            ...(origin.agentDriver === undefined ? {} : { agentDriver: origin.agentDriver }),
            ...(origin.repository === undefined ? {} : { repository: origin.repository }),
            ...(origin.branch === undefined ? {} : { branch: origin.branch }),
            chat: {
              threadId,
              firstTurn: {
                messageId: MessageId.make(yield* uuid),
                text: message,
                title: input.title,
                modelSelection,
                runtimeMode: input.runtimeMode ?? source.chat?.thread.runtimeMode ?? "full-access",
                interactionMode: input.interactionMode ?? "default",
                createdAt,
              },
            },
          });
        }).pipe(Effect.map((result) => ({ threadId, result }))),
      );
      if (claim === "busy")
        return yield* failure(
          "capability_denied",
          "This chat is still starting another cloud chat. Try again once that one is ready.",
        );
      if (claim === "full")
        return yield* failure(
          "capability_denied",
          `This chat already has ${MAX_STARTED_CHATS} cloud chats it started. Delete one of their machines first.`,
        );
      const provisioned = yield* Fiber.join(claim).pipe(
        Effect.timeoutOption(LAUNCH_BUDGET),
        Effect.mapError(() =>
          failure("orchestration_error", "The new cloud chat could not start."),
        ),
      );
      if (Option.isNone(provisioned)) return yield* stillStarting;
      const { result } = provisioned.value;
      if (result.kind === "refused") return yield* failure("orchestration_error", result.message);
      if (result.kind !== "ready") return yield* stillStarting;
      // The chat's first turn started on its box, which links and lists it.
      const listed = yield* invokeOn(result.environment.leaseId, input.title, {
        actor,
        request: { op: "threads.list", input: {} },
      }).pipe(
        Effect.flatMap((body) =>
          decodeThreadList(body).pipe(
            Effect.mapError(() => unavailable("The new cloud chat answered in an unknown shape.")),
          ),
        ),
        Effect.timeoutOption(FOLLOW_UP_BUDGET),
      );
      if (Option.isNone(listed)) return yield* stillStarting;
      const thread = listed.value.threads.find(
        (candidate) => candidate.threadId === provisioned.value.threadId,
      );
      if (thread === undefined) return yield* stillStarting;
      return {
        threadId: thread.threadId,
        link: thread.link,
        projectId: thread.projectId,
        modelSelection,
        runId: thread.latestRunId,
        status: thread.status === "idle" ? null : thread.status,
      } satisfies FleetResult<"threads.launch">;
    });

  /**
   * Runs one call a box relays. Only another cloud chat's box, or a new one, is a target. The host
   * decides who asks from its own records, never the box's claim: the box's own chat, with the
   * modes on the host's card. Changes and wakes need that card to be full-access/default.
   */
  const relay = (sourceLeaseId: string, { environmentId, invoke }: FleetHostRequest) =>
    Effect.gen(function* () {
      const boxes = yield* chatBoxes;
      const { request, actor } = invoke;
      const source = boxes.find((box) => box.leaseId === sourceLeaseId);
      if (
        source === undefined ||
        actor.environmentId !== source.environmentId ||
        actor.threadId !== source.threadId
      )
        return yield* failure(
          "capability_denied",
          "Only this machine's own chat can act through its host.",
        );
      if (CHANGES_STATE[request.op] && !actsFully(source))
        return yield* failure(
          "capability_denied",
          "Changing another cloud chat needs this chat in full-access/default mode.",
        );
      if (environmentId === CLOUD_FORKS_ENVIRONMENT_ID) {
        if (request.op === "forks.run") return yield* forks.run(source, actor, request.input);
        if (request.op === "forks.status") return yield* forks.status(source, request.input);
        return yield* failure(
          "invalid_request",
          "Only t3_fork_run and t3_fork_status work in the forks environment.",
        );
      }
      if (request.op === "forks.run" || request.op === "forks.status")
        return yield* failure("invalid_request", "Forks run only in the forks environment.");
      if (environmentId === NEW_CLOUD_CHAT_ENVIRONMENT_ID) {
        if (request.op !== "threads.launch")
          return yield* failure(
            "invalid_request",
            "Only t3_thread_launch works in the new cloud chat environment.",
          );
        return yield* startChat(source, boxes, actor, request.input);
      }
      const target = boxes.find(
        (box) => box.environmentId === environmentId && box.leaseId !== sourceLeaseId,
      );
      if (target === undefined)
        return yield* unavailable(`Environment ${environmentId} is not one of your cloud chats.`);
      if (request.op === "threads.list" && target.lifecycle === "paused" && target.chat) {
        const card = target.chat;
        const shells =
          request.input.projectId === undefined || request.input.projectId === card.project.id
            ? [card.thread]
            : [];
        return listThreadPage(shells, request.input, {
          actor,
          environmentId: target.environmentId,
          nowMs: yield* Clock.currentTimeMillis,
        });
      }
      if (target.lifecycle === "missing")
        return yield* unavailable(`${boxName(target)} has no machine right now.`);
      if (target.lifecycle === "paused") {
        // Waking a machine costs money, so it is a change too.
        if (!actsFully(source))
          return yield* unavailable(
            `${boxName(target)} is asleep, and only a full-access chat can wake it.`,
          );
        const startedAt = yield* Clock.currentTimeMillis;
        yield* wake(target);
        if ((yield* Clock.currentTimeMillis) - startedAt > RELAY_DEADLINE_MS)
          return yield* unavailable(`${boxName(target)} just woke up. Try again now.`);
      }
      return yield* invokeOn(target.leaseId, boxName(target), invoke);
    });

  const answer = (sourceLeaseId: string, request: FleetHostRequest) =>
    relay(sourceLeaseId, request).pipe(
      Effect.match({
        onFailure: (error): FleetHostResponse => ({ requestId: request.requestId, failure: error }),
        onSuccess: (result): FleetHostResponse => ({ requestId: request.requestId, result }),
      }),
    );

  const track = (leaseId: string, delta: number) =>
    Effect.sync(() => {
      const count = (inFlight.get(leaseId) ?? 0) + delta;
      if (count === 0) inFlight.delete(leaseId);
      else inFlight.set(leaseId, count);
    });

  /** Schedules the next try at a box whose connection ended on its own. */
  const noteEnded = (leaseId: string, openedAt: number, exit: Exit.Exit<unknown, unknown>) =>
    Effect.gen(function* () {
      if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return;
      const now = yield* Clock.currentTimeMillis;
      if (now - openedAt >= Duration.toMillis(RECONCILE_INTERVAL)) {
        retries.delete(leaseId);
        return;
      }
      const failures = (retries.get(leaseId)?.failures ?? 0) + 1;
      retries.set(leaseId, {
        failures,
        retryAt: now + Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS),
      });
    });

  /** One connection per awake box; a changed registration re-registers on it. */
  const serve = (
    source: Box,
    access: RemoteAccess,
    registration: SubscriptionRef.SubscriptionRef<FleetHostRegistration>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* boxClient.open(access);
        const openedAt = yield* Clock.currentTimeMillis;
        yield* SubscriptionRef.changes(registration).pipe(
          Stream.switchMap(connection.connect),
          Stream.runForEach((request) =>
            Effect.acquireUseRelease(
              track(source.leaseId, 1),
              () => answer(source.leaseId, request).pipe(Effect.flatMap(connection.respond)),
              () => track(source.leaseId, -1),
            ).pipe(Effect.ignore, Effect.forkScoped),
          ),
          Effect.onExit((exit) => noteEnded(source.leaseId, openedAt, exit)),
        );
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("cloud chat fleet connection ended", { leaseId: source.leaseId, cause }),
      ),
    );

  const reconcile = Effect.gen(function* () {
    const boxes = yield* chatBoxes;
    const now = yield* Clock.currentTimeMillis;
    const awake = new Set<string>();
    for (const box of boxes) {
      if (box.lifecycle !== "active") continue;
      const access = yield* accessOf(box.leaseId);
      if (access === null) continue;
      awake.add(box.leaseId);
      const registration = registrationFor(box, boxes);
      // A card's updatedAt moves with every turn; re-registering for it alone would churn.
      const key = encodeKey(
        registration.environments.map(({ chat, ...environment }) => ({
          ...environment,
          chat: chat && { threadId: chat.threadId, title: chat.title, status: chat.status },
        })),
      );
      const current = registered.get(box.leaseId);
      if (current !== undefined && FiberMap.hasUnsafe(connections, box.leaseId)) {
        if (current.key === key || inFlight.has(box.leaseId)) continue;
        registered.set(box.leaseId, { ...current, key });
        yield* SubscriptionRef.set(current.registration, registration);
        continue;
      }
      if ((retries.get(box.leaseId)?.retryAt ?? 0) > now) continue;
      const ref = yield* SubscriptionRef.make(registration);
      registered.set(box.leaseId, { key, registration: ref });
      yield* FiberMap.run(connections, box.leaseId, serve(box, access, ref));
    }
    for (const leaseId of registered.keys()) {
      if (awake.has(leaseId)) continue;
      registered.delete(leaseId);
      retries.delete(leaseId);
      yield* FiberMap.remove(connections, leaseId);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("cloud chat fleet could not be reconciled", { message: error.message }),
    ),
    Effect.withSpan("CloudFleetHost.reconcile"),
  );

  return CloudFleetHost.of({
    reconcile,
    start: Effect.gen(function* () {
      yield* forks.sweep.pipe(
        Effect.repeat(Schedule.spaced(FORK_SWEEP_INTERVAL)),
        Effect.forkScoped,
      );
      yield* reconcile.pipe(Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)), Effect.forkScoped);
    }),
  });
});

export const layer = Layer.effect(CloudFleetHost, make).pipe(
  Layer.provide(ProvisionOperationStore.layer),
);
