import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const nativeSession = "native-session-1";
const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("thread:background-after-limit");

/** The Claude CLI process the adapter opened, and whether it was closed. */
interface FakeCli {
  readonly messages: Queue.Queue<SDKMessage, Cause.Done>;
  readonly closed: Ref.Ref<boolean>;
}

const backgroundTasks = (tasks: ReadonlyArray<{ task_id: string; description: string }>) =>
  ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: tasks.map((task) => ({ ...task, task_type: "local_bash" })),
    uuid: `roster-${tasks.length}`,
    session_id: nativeSession,
  }) as unknown as SDKMessage;

const usageLimitResult = {
  type: "result",
  subtype: "success",
  uuid: "limited",
  session_id: nativeSession,
  is_error: true,
  num_turns: 1,
  result: "You've hit your limit",
  stop_reason: "end_turn",
  terminal_reason: "blocking_limit",
  permission_denials: [],
  duration_ms: 1,
  duration_api_ms: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
  modelUsage: {},
} as unknown as SDKMessage;

/** The orchestration runtime with the real Claude adapter behind a fake CLI. */
const runtime = (cli: Ref.Ref<FakeCli | undefined>, cwd: string) =>
  ProviderReplayHarness.layerWithRegistry(
    { name: "claude-background-after-limit" },
    ProviderAdapterRegistry.layerFromAdaptersEffect(
      Effect.gen(function* () {
        return [
          ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId,
            settings: Schema.decodeSync(ClaudeSettings)({}),
            environment: {},
            attachmentsDir: cwd,
            fileSystem: yield* FileSystem.FileSystem,
            path: yield* Path.Path,
            idAllocator: yield* IdAllocator.IdAllocatorV2,
            queryRunner: {
              allocateSessionId: Effect.succeed(nativeSession),
              open: () =>
                Effect.gen(function* () {
                  const messages = yield* Queue.unbounded<SDKMessage, Cause.Done>();
                  const closed = yield* Ref.make(false);
                  yield* Ref.set(cli, { messages, closed });
                  // Closing the CLI ends its process, and the background shells it runs.
                  const close = Ref.set(closed, true).pipe(Effect.andThen(Queue.end(messages)));
                  return {
                    messages: Stream.fromQueue(messages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    interrupt: Effect.void,
                    close: Effect.asVoid(close),
                  };
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          }),
        ];
      }),
    ),
  );

/** Waits in the background for the first domain event matching `predicate` from now on. */
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

const rosterCleared = (event: OrchestrationV2DomainEvent) =>
  event.type === "provider-thread.updated" && event.payload.pendingBackgroundTasks?.length === 0;

const devServer = { taskId: "bash-1", kind: "command", description: "bun run dev" } as const;

/**
 * Runs a chat whose turn starts a background dev server and then fails on the usage limit,
 * and hands the test the fake CLI with the shell still running.
 */
const limitedChat = (cli: Ref.Ref<FakeCli | undefined>, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:background-after-limit"),
      title: "Background after limit",
      modelSelection: { instanceId, model: "claude-sonnet-4-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* watch(
      (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("first"),
      text: "Start the dev server in the background.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);

    const { messages } = (yield* Ref.get(cli))!;
    const failed = yield* watch(
      (event) => event.type === "run.updated" && event.payload.status === "failed",
    );
    yield* Queue.offer(
      messages,
      backgroundTasks([{ task_id: devServer.taskId, description: devServer.description }]),
    );
    yield* Queue.offer(messages, usageLimitResult);
    yield* Fiber.join(failed);
    yield* worker.drain();
    return (yield* Ref.get(cli))!;
  });

it.layer(NodeServices.layer)("Claude background work after a usage limit", (it) => {
  it.effect("keeps a background shell listed and stoppable after its turn hits the limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-background-after-limit-stop");
        const cli = yield* Ref.make<FakeCli | undefined>(undefined);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const { closed } = yield* limitedChat(cli, cwd);

          const limited = yield* orchestrator.getThreadShell(threadId);
          assert.deepEqual(limited?.pendingBackgroundTasks, [devServer]);

          // Stop, as the background-work banner sends it.
          const cleared = yield* watch(rosterCleared);
          const failedRun = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: failedRun.id,
            holdQueue: true,
          });
          yield* worker.drain();
          yield* Fiber.join(cleared);

          assert.isTrue(yield* Ref.get(closed));
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(Effect.provide(runtime(cli, cwd)));
      }),
    ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("clears a background shell that ends after its turn hit the limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("claude-background-after-limit-ends");
        const cli = yield* Ref.make<FakeCli | undefined>(undefined);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { messages, closed } = yield* limitedChat(cli, cwd);
          assert.deepEqual((yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks, [
            devServer,
          ]);

          const cleared = yield* watch(rosterCleared);
          yield* Queue.offer(messages, backgroundTasks([]));
          yield* Fiber.join(cleared);

          assert.isFalse(yield* Ref.get(closed));
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(Effect.provide(runtime(cli, cwd)));
      }),
    ).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});
