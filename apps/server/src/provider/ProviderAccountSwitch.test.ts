import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { makeAccountRotation } from "../environmentControl/accountSwitch.ts";
import { createProvisionedLeaseRegistry } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import { ownerChat } from "../environmentControl/provisionedChats.ts";
import { boxShell } from "../environmentControl/shellTestFixture.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ProviderAccountSwitch from "./ProviderAccountSwitch.ts";
import type { ProviderDriver, ProviderInstance } from "./ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";

const nativeSession = "native-session-1";
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId: claudeInstanceId, model: "claude-sonnet-4-6" };
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const encodeShellThread = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadShell));
/** A thread as a box's shell route sends it. */
const shellThread = (shell: OrchestrationV2ThreadShell) =>
  JSON.parse(JSON.stringify(encodeShellThread(shell))) as Record<string, unknown>;

/** One Claude CLI process the adapter started: the login it ran with and the session it resumed. */
interface OpenedQuery {
  readonly token: string | undefined;
  readonly resume: string | undefined;
  readonly messages: Queue.Queue<SDKMessage>;
}

const result = (uuid: string, limited: boolean) =>
  ({
    type: "result",
    subtype: "success",
    uuid,
    session_id: nativeSession,
    is_error: limited,
    num_turns: 1,
    result: limited ? "You've hit your limit" : "Done.",
    stop_reason: "end_turn",
    terminal_reason: limited ? "blocking_limit" : "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  }) as unknown as SDKMessage;

/** Holds the registry's rebuild onto the second account until the test releases it. */
interface RebuildGate {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

/**
 * The real Claude adapter behind a fake CLI. Each instance the registry builds reads its login from
 * settings, as the shipped driver does, and every CLI process it opens is recorded.
 */
const claudeDriver = (
  opened: Ref.Ref<ReadonlyArray<OpenedQuery>>,
  cwd: string,
  rebuild?: RebuildGate,
) =>
  ({
    driverKind: ProviderDriverKind.make("claudeAgent"),
    metadata: { displayName: "Claude", supportsMultipleInstances: true },
    configSchema: ClaudeSettings,
    defaultConfig: () => decodeClaudeSettings({}),
    create: ({ instanceId, environment, enabled, config }) =>
      Effect.gen(function* () {
        const env = mergeProviderInstanceEnvironment(environment);
        if (rebuild && env.CLAUDE_CODE_OAUTH_TOKEN === "token-b") {
          yield* Deferred.succeed(rebuild.started, undefined);
          yield* Deferred.await(rebuild.release);
        }
        const orchestrationAdapter = ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId,
          settings: config,
          environment: env,
          attachmentsDir: cwd,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed(nativeSession),
            open: ({ options }) =>
              Effect.gen(function* () {
                const messages = yield* Queue.unbounded<SDKMessage>();
                yield* Ref.update(opened, (all) => [
                  ...all,
                  { token: options.env?.CLAUDE_CODE_OAUTH_TOKEN, resume: options.resume, messages },
                ]);
                return {
                  messages: Stream.fromQueue(messages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        return {
          instanceId,
          driverKind: ProviderDriverKind.make("claudeAgent"),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("claudeAgent"),
            continuationKey: "claude:home:test",
          },
          displayName: undefined,
          enabled,
          orchestrationAdapter,
        } as unknown as ProviderInstance;
      }),
  }) satisfies ProviderDriver<
    ClaudeSettings,
    IdAllocator.IdAllocatorV2 | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >;

/**
 * The box's server as far as a switch reaches: settings on disk, the provider registry rebuilt from
 * them, and the orchestration runtime that runs the chat's turns.
 */
const boxRuntime = (
  opened: Ref.Ref<ReadonlyArray<OpenedQuery>>,
  cwd: string,
  rebuild?: RebuildGate,
) => {
  const settingsLayer = ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-switch-" })),
    Layer.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  );
  const instancesLayer = ProviderInstanceRegistryHydration.layerWithDrivers([
    claudeDriver(opened, cwd, rebuild),
  ]).pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provide(Layer.mergeAll(IdAllocator.layer, NodeServices.layer, NodeCrypto.layer)),
  );
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "provider-account-switch" },
    ProviderAdapterRegistry.layerFromProviderInstanceRegistry.pipe(Layer.provide(instancesLayer)),
  );
  return ProviderAccountSwitch.layer.pipe(
    Layer.provideMerge(runtime),
    Layer.provideMerge(instancesLayer),
  );
};

/**
 * Waits in the background for the first domain event matching `predicate` from now on. The start
 * is read before the fiber forks: a fiber that first runs after the event commits would otherwise
 * begin past it and wait forever.
 */
const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    return yield* sink.stream({ afterSequence }).pipe(
      Stream.map(({ event }) => event),
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

const threadId = ThreadId.make("thread:account-switch");

/** Saves an instance and waits until the registry runs it. */
const saveInstance = (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
      const changes = yield* instances.subscribeChanges;
      const previous = yield* instances.getInstance(instanceId);
      yield* settings.updateProviderInstance({ operation: "upsert", instanceId, instance });
      if (instance.driver !== "claudeAgent") return;
      while ((yield* instances.getInstance(instanceId)) === previous) yield* PubSub.take(changes);
    }),
  );

const createThread = (cwd: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:account-switch"),
      title: "Account switch",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    }),
  );

it.layer(NodeServices.layer)("ProviderAccountSwitch", (it) => {
  it.effect(
    "moves a chat that hit its limit onto the new login and resumes the same Claude session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("provider-account-switch");
          const opened = yield* Ref.make<ReadonlyArray<OpenedQuery>>([]);
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const configDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
          const staleLogin = path.join(configDir, ".credentials.json");
          yield* fs.writeFileString(staleLogin, '{"claudeAiOauth":{}}');

          yield* Effect.gen(function* () {
            const settings = yield* ServerSettingsModule.ServerSettingsService;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
            const latestQuery = Ref.get(opened).pipe(Effect.map((all) => all.at(-1)!));
            const toSecondAccount = (continueRunId?: RunId) =>
              accounts.switchAccount({
                driver: "claudeAgent",
                displayName: "Second account",
                accountEmail: "second@example.com",
                credential: {
                  kind: "environment",
                  variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-b" }],
                },
                threadId,
                ...(continueRunId === undefined ? {} : { continueRunId }),
              });

            yield* saveInstance(claudeInstanceId, {
              driver: ProviderDriverKind.make("claudeAgent"),
              displayName: "First account",
              config: { accountEmail: "first@example.com" },
              environment: [
                { name: "CLAUDE_CONFIG_DIR", value: configDir, sensitive: false },
                { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-a", sensitive: true },
              ],
            });
            yield* createThread(cwd);
            const firstRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("first"),
              threadId,
              messageId: MessageId.make("first"),
              text: "Build it.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(firstRunning);

            assert.deepEqual(yield* toSecondAccount(), {
              kind: "refused",
              reason: "busy",
              message: "This chat is working. Switch accounts once its turn ends.",
            });

            const limited = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            yield* Queue.offer((yield* latestQuery).messages, result("limited", true));
            yield* Fiber.join(limited);
            yield* worker.drain();
            const failedRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;

            const firstTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
            const continuedRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.id !== firstTurn.id,
            );
            const switched = yield* toSecondAccount(failedRun.id);
            yield* worker.drain();
            yield* Fiber.join(continuedRunning);

            assert.deepEqual(switched, { kind: "switched", continued: true });
            assert.deepEqual(
              (yield* Ref.get(opened)).map(({ token, resume }) => ({ token, resume })),
              [
                { token: "token-a", resume: undefined },
                { token: "token-b", resume: nativeSession },
              ],
            );
            const after = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              after.runs.map((run) => run.status),
              ["failed", "running"],
            );
            assert.equal(after.messages.at(-1)?.text, "Continue where you left off.");
            const instance = (yield* settings.getSettings).providerInstances[claudeInstanceId];
            assert.equal(instance?.displayName, "Second account");
            assert.deepEqual(instance?.config, { accountEmail: "second@example.com" });
            assert.isFalse(yield* fs.exists(staleLogin));
          }).pipe(Effect.provide(boxRuntime(opened, cwd)));
        }),
      ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect(
    "leaves a turn that started while the instance rebuilt running, and does not continue",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("provider-account-switch-race");
          const opened = yield* Ref.make<ReadonlyArray<OpenedQuery>>([]);
          const rebuild: RebuildGate = {
            started: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
            const send = (id: string, text: string) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(id),
                text,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });

            yield* saveInstance(claudeInstanceId, {
              driver: ProviderDriverKind.make("claudeAgent"),
              environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-a", sensitive: true }],
            });
            yield* createThread(cwd);
            const firstRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            yield* send("first", "Build it.");
            yield* worker.drain();
            yield* Fiber.join(firstRunning);
            const limited = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            const [query] = yield* Ref.get(opened);
            yield* Queue.offer(query!.messages, result("limited", true));
            yield* Fiber.join(limited);
            yield* worker.drain();
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const failedRun = projection.runs[0]!;

            const switching = yield* accounts
              .switchAccount({
                driver: "claudeAgent",
                credential: {
                  kind: "environment",
                  variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-b" }],
                },
                threadId,
                continueRunId: failedRun.id,
              })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(rebuild.started);
            const nextRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.id !== projection.providerTurns[0]!.id,
            );
            yield* send("next", "Try the next step.");
            yield* worker.drain();
            yield* Fiber.join(nextRunning);
            yield* Deferred.succeed(rebuild.release, undefined);
            const switched = yield* Fiber.join(switching);
            yield* worker.drain();

            const after = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(switched, { kind: "switched", continued: false });
            assert.deepEqual(
              after.runs.map((run) => run.status),
              ["failed", "running"],
            );
            assert.deepEqual(
              after.messages.map((message) => message.text),
              ["Build it.", "Try the next step."],
            );
            assert.deepEqual(
              (yield* Ref.get(opened)).map(({ token }) => token),
              ["token-a"],
            );
          }).pipe(Effect.provide(boxRuntime(opened, cwd, rebuild)));
        }),
      ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect(
    "switches a limited chat with a message queued behind it, which then runs on the new login",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("provider-account-switch-queued");
          const opened = yield* Ref.make<ReadonlyArray<OpenedQuery>>([]);

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
            const send = (
              id: string,
              text: string,
              dispatchMode: { readonly type: "start_immediately" | "queue_after_active" },
            ) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(id),
                threadId,
                messageId: MessageId.make(id),
                text,
                attachments: [],
                dispatchMode,
                createdBy: "user",
                creationSource: "web",
              });
            const latestQuery = Ref.get(opened).pipe(Effect.map((all) => all.at(-1)!));

            yield* saveInstance(claudeInstanceId, {
              driver: ProviderDriverKind.make("claudeAgent"),
              environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-a", sensitive: true }],
            });
            yield* createThread(cwd);
            const firstRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            yield* send("first", "Build it.", { type: "start_immediately" });
            yield* worker.drain();
            yield* Fiber.join(firstRunning);
            yield* send("queued", "Then add tests.", { type: "queue_after_active" });
            const limited = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            yield* Queue.offer((yield* latestQuery).messages, result("limited", true));
            yield* Fiber.join(limited);
            yield* worker.drain();
            const before = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              before.runs.map((run) => run.status),
              ["failed", "queued"],
            );

            const continuationRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.id !== before.providerTurns[0]!.id,
            );
            const switched = yield* accounts.switchAccount({
              driver: "claudeAgent",
              credential: {
                kind: "environment",
                variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-b" }],
              },
              threadId,
              continueRunId: before.runs[0]!.id,
            });
            yield* worker.drain();
            yield* Fiber.join(continuationRunning);
            const continuing = yield* orchestrator.getThreadProjection(threadId);
            const queuedRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                !continuing.providerTurns.some((turn) => turn.id === event.payload.id),
            );
            yield* Queue.offer((yield* latestQuery).messages, result("continued", false));
            yield* worker.drain();
            yield* Fiber.join(queuedRunning);

            const after = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(switched, { kind: "switched", continued: true });
            assert.deepEqual(
              after.runs.map((run) => [run.status, run.ordinal]),
              [
                ["failed", 1],
                ["running", 2],
                ["completed", 3],
              ],
            );
            assert.deepEqual(
              (yield* Ref.get(opened)).map(({ token }) => token),
              ["token-a", "token-b"],
            );
          }).pipe(Effect.provide(boxRuntime(opened, cwd)));
        }),
      ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect(
    "rotates a chat whose limit landed with a background wake queued behind it, then runs the wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("provider-account-switch-wake");
          const opened = yield* Ref.make<ReadonlyArray<OpenedQuery>>([]);

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
            const leases = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
            // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the host's account rotation is Promise-facing, and reaches the box through this
            const onBox = Effect.runPromiseWith(
              yield* Effect.context<ProviderAccountSwitch.ProviderAccountSwitch>(),
            );
            const latestQuery = Ref.get(opened).pipe(Effect.map((all) => all.at(-1)!));

            yield* saveInstance(claudeInstanceId, {
              driver: ProviderDriverKind.make("claudeAgent"),
              environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-a", sensitive: true }],
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create"),
              threadId,
              projectId: ProjectId.make("project-app"),
              title: "Account switch",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const firstRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" && event.payload.status === "running",
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("first"),
              threadId,
              messageId: MessageId.make("first"),
              text: "Build it.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            yield* worker.drain();
            yield* Fiber.join(firstRunning);
            // A background task ends while the turn that hits the limit is still settling: its
            // wake queues behind that turn, as the provider continuation service sends it.
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("wake"),
              threadId,
              messageId: MessageId.make("wake"),
              text: "Background task completed.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "provider",
            });
            const limited = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            yield* Queue.offer((yield* latestQuery).messages, result("limited", true));
            yield* Fiber.join(limited);
            yield* worker.drain();
            const before = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              before.runs.map((run) => run.status),
              ["failed", "queued"],
            );

            yield* Effect.promise(async () => {
              await leases.register({
                leaseId: "lease-1",
                sandboxId: "box-1",
                providerInstanceId: "claude-a",
                owner: { environmentId: "box-env", threadId },
              });
              await leases.markActive({
                leaseId: "lease-1",
                remoteAccess: { origin: "https://box.example", brokerToken: "broker" },
              });
            });
            const readShell = Effect.gen(function* () {
              const shell = yield* orchestrator.getThreadShell(threadId);
              return boxShell([shellThread(shell!)]);
            });
            const outcomes: Array<unknown> = [];
            const rotation = makeAccountRotation({
              ports: {
                readShell: () => onBox(readShell),
                accountDriver: async () => "claudeAgent",
                pickAccount: async (_driver, exclude) =>
                  exclude.has("claude-b")
                    ? null
                    : {
                        instanceId: "claude-b",
                        name: "Claude claude-b",
                        credential: {
                          kind: "environment",
                          variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-b" }],
                        },
                      },
                sendSwitch: (_lease, input) => onBox(accounts.switchAccount(input)),
              },
              leases,
              enabled: async () => true,
              holdBox: async () => () => {},
              report: (_lease, outcome) => outcomes.push(outcome),
            });
            const lease = (yield* Effect.promise(() => leases.findById("lease-1")))!;
            const chat = ownerChat(yield* readShell, threadId)!;
            assert.isTrue(yield* Effect.promise(() => rotation.due(lease, chat)));

            const continuationRunning = yield* watch(
              (event) =>
                event.type === "provider-turn.updated" &&
                event.payload.status === "running" &&
                event.payload.id !== before.providerTurns[0]!.id,
            );
            yield* Effect.promise(() => rotation.start(lease));
            assert.deepEqual(outcomes, [
              {
                kind: "done",
                result: { kind: "switched", account: "Claude claude-b", continued: true },
              },
            ]);
            yield* worker.drain();
            yield* Fiber.join(continuationRunning);

            const wakeSettled = yield* watch(
              (event) =>
                event.type === "run.updated" &&
                event.payload.id === before.runs[1]!.id &&
                event.payload.status === "completed",
            );
            yield* Queue.offer((yield* latestQuery).messages, result("continued", false));
            yield* worker.drain();
            yield* Fiber.join(wakeSettled);

            const after = yield* orchestrator.getThreadProjection(threadId);
            assert.deepEqual(
              after.runs.map((run) => [run.status, run.ordinal]),
              [
                ["failed", 1],
                ["completed", 2],
                ["completed", 3],
              ],
            );
            assert.deepEqual(
              (yield* Ref.get(opened)).map(({ token }) => token),
              ["token-a", "token-b"],
            );
          }).pipe(Effect.provide(boxRuntime(opened, cwd)));
        }),
      ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("writes a Codex login into the instance's home, beside its sessions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("provider-account-switch-codex");
        const opened = yield* Ref.make<ReadonlyArray<OpenedQuery>>([]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-home-" });
        const session = path.join(codexHome, "sessions", "2026", "rollout-1.jsonl");
        yield* fs.makeDirectory(path.dirname(session), { recursive: true });
        yield* fs.writeFileString(session, '{"type":"session_meta"}\n');
        yield* fs.writeFileString(path.join(codexHome, "auth.json"), '{"account":"first"}');
        const codexInstanceId = ProviderInstanceId.make("codex");

        yield* Effect.gen(function* () {
          const settings = yield* ServerSettingsModule.ServerSettingsService;
          const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
          yield* saveInstance(codexInstanceId, {
            driver: ProviderDriverKind.make("codex"),
            displayName: "First Codex",
            config: { homePath: codexHome, shadowHomePath: "" },
          });
          yield* createThread(cwd);

          const switched = yield* accounts.switchAccount({
            driver: "codex",
            displayName: "Second Codex",
            credential: {
              kind: "file",
              contentsBase64: Buffer.from('{"account":"second"}').toString("base64"),
            },
            threadId,
          });

          assert.deepEqual(switched, { kind: "switched", continued: false });
          assert.equal(
            yield* fs.readFileString(path.join(codexHome, "auth.json")),
            '{"account":"second"}',
          );
          assert.equal(
            ((yield* fs.stat(path.join(codexHome, "auth.json"))).mode & 0o777).toString(8),
            "600",
          );
          assert.equal(yield* fs.readFileString(session), '{"type":"session_meta"}\n');
          const instance = (yield* settings.getSettings).providerInstances[codexInstanceId];
          assert.equal(instance?.displayName, "Second Codex");
          assert.deepEqual(instance?.config, { homePath: codexHome, shadowHomePath: "" });
        }).pipe(Effect.provide(boxRuntime(opened, cwd)));
      }),
    ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("refuses a credential variable that is not its driver's login", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("provider-account-switch-refused");
        const opened = yield* Ref.make<ReadonlyArray<OpenedQuery>>([]);
        yield* Effect.gen(function* () {
          const accounts = yield* ProviderAccountSwitch.ProviderAccountSwitch;
          const settings = yield* ServerSettingsModule.ServerSettingsService;
          const instance = {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-a", sensitive: true }],
          };
          yield* saveInstance(claudeInstanceId, instance);
          yield* createThread(cwd);
          assert.deepEqual(
            yield* accounts.switchAccount({
              driver: "claudeAgent",
              credential: { kind: "environment", variables: [{ name: "PATH", value: "/tmp" }] },
              threadId,
            }),
            {
              kind: "refused",
              reason: "unsupported",
              message: "This machine has no account of that provider to switch.",
            },
          );
          assert.deepEqual(
            (yield* settings.getSettings).providerInstances[claudeInstanceId]?.environment?.map(
              ({ name, value }) => ({ name, value }),
            ),
            [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token-a" }],
          );
        }).pipe(Effect.provide(boxRuntime(opened, cwd)));
      }),
    ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});
