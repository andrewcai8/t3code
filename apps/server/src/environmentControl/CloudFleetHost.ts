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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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
import * as BoxFleetClient from "./BoxFleetClient.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";
import { listProvisionedEnvironments } from "./ProvisionDiscovery.ts";
import { createProvisionedLeaseRegistry, type RemoteAccess } from "./ProvisionedLeaseRegistry.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";

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
    /** Reconciles now and on an interval, for the life of the scope. */
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

/** What one box is offered: every other cloud chat, then a new one unless a chat started it. */
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
    ],
  };
}

const decodeThreadList = Schema.decodeUnknownEffect(FleetResults["threads.list"]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const environmentControl = yield* EnvironmentControl.EnvironmentControl;
  const operations = yield* ProvisionOperationStore;
  const boxClient = yield* BoxFleetClient.BoxFleetClient;
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
      const started = boxes.filter((box) => box.threadId?.startsWith(startedBy(source))).length;
      if (started >= MAX_STARTED_CHATS)
        return yield* failure(
          "capability_denied",
          `This chat already has ${MAX_STARTED_CHATS} cloud chats it started. Delete one of their machines first.`,
        );
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
      const launch = yield* once(
        `launch:${actor.environmentId}:${actor.threadId}:${input.title}\u0000${message}`,
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
      const provisioned = yield* Fiber.join(launch).pipe(
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

  /** Runs one call a box relays. Only another cloud chat's box, or a new one, is a target. */
  const relay = (source: Box, { environmentId, invoke }: FleetHostRequest) =>
    Effect.gen(function* () {
      const boxes = yield* chatBoxes;
      const { request, actor } = invoke;
      if (environmentId === NEW_CLOUD_CHAT_ENVIRONMENT_ID) {
        if (request.op !== "threads.launch")
          return yield* failure(
            "invalid_request",
            "Only t3_thread_launch works in the new cloud chat environment.",
          );
        const current = boxes.find((box) => box.leaseId === source.leaseId);
        return yield* startChat(current, boxes, actor, request.input);
      }
      const target = boxes.find(
        (box) => box.environmentId === environmentId && box.leaseId !== source.leaseId,
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
        const startedAt = yield* Clock.currentTimeMillis;
        yield* wake(target);
        if ((yield* Clock.currentTimeMillis) - startedAt > RELAY_DEADLINE_MS)
          return yield* unavailable(`${boxName(target)} just woke up. Try again now.`);
      }
      return yield* invokeOn(target.leaseId, boxName(target), invoke);
    });

  const answer = (source: Box, request: FleetHostRequest) =>
    relay(source, request).pipe(
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

  /** One connection per awake box; a changed registration re-registers on it. */
  const serve = (
    source: Box,
    access: RemoteAccess,
    registration: SubscriptionRef.SubscriptionRef<FleetHostRegistration>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* boxClient.open(access);
        yield* SubscriptionRef.changes(registration).pipe(
          Stream.switchMap(connection.connect),
          Stream.runForEach((request) =>
            Effect.acquireUseRelease(
              track(source.leaseId, 1),
              () => answer(source, request).pipe(Effect.flatMap(connection.respond)),
              () => track(source.leaseId, -1),
            ).pipe(Effect.ignore, Effect.forkScoped),
          ),
        );
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logDebug("cloud chat fleet connection ended", { leaseId: source.leaseId, cause }),
      ),
    );

  const reconcile = Effect.gen(function* () {
    const boxes = yield* chatBoxes;
    const awake = new Set<string>();
    for (const box of boxes) {
      if (box.lifecycle !== "active") continue;
      const access = yield* accessOf(box.leaseId);
      if (access === null) continue;
      awake.add(box.leaseId);
      const registration = registrationFor(box, boxes);
      // A card's updatedAt moves with every turn; re-registering for it alone would churn.
      const key = JSON.stringify(
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
      const ref = yield* SubscriptionRef.make(registration);
      registered.set(box.leaseId, { key, registration: ref });
      yield* FiberMap.run(connections, box.leaseId, serve(box, access, ref));
    }
    for (const leaseId of registered.keys()) {
      if (awake.has(leaseId)) continue;
      registered.delete(leaseId);
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
    start: reconcile.pipe(
      Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)),
      Effect.forkScoped,
      Effect.asVoid,
    ),
  });
});

export const layer = Layer.effect(CloudFleetHost, make).pipe(
  Layer.provide(ProvisionOperationStore.layer),
);
