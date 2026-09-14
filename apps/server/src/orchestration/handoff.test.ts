// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  ClientOrchestrationCommand,
  CommandId,
  EventId,
  MessageId,
  OrchestrationProposedPlanId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const threadId = ThreadId.make("handoff-thread");
const projectId = ProjectId.make("handoff-project");
const turnId = TurnId.make("handoff-turn");
const createdAt = "2026-09-13T00:00:00.000Z";
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
const begin = {
  type: "thread.handoff.begin",
  commandId: CommandId.make("handoff-begin"),
  threadId,
} satisfies OrchestrationCommand;
const turn = {
  type: "thread.turn.start",
  commandId: CommandId.make("handoff-original-turn"),
  threadId,
  message: {
    messageId: MessageId.make("handoff-message"),
    role: "user",
    text: "Original work",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt,
} satisfies OrchestrationCommand;

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);

function openSystem(directory: string) {
  // Restart tests must close the SQLite owner before opening the next engine.
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests
  const runtime = ManagedRuntime.make(
    OrchestrationLayerLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
      Layer.provide(ServerConfig.layerTest(directory, NodePath.join(directory, "home"))),
      Layer.provide(NodeServices.layer),
    ),
  );
  return {
    dispatch: (command: OrchestrationCommand) =>
      runtime.runPromise(
        Effect.flatMap(OrchestrationEngineService, (engine) => engine.dispatch(command)),
      ),
    snapshot: () =>
      runtime.runPromise(Effect.flatMap(ProjectionSnapshotQuery, (query) => query.getSnapshot())),
    events: () =>
      runtime.runPromise(
        Effect.flatMap(OrchestrationEngineService, (engine) =>
          Stream.runCollect(engine.readEvents(0)),
        ),
      ),
    appendEvent: (event: Omit<OrchestrationEvent, "sequence">) =>
      runtime.runPromise(Effect.flatMap(OrchestrationEventStore, (store) => store.append(event))),
    dispose: () => runtime.dispose(),
  };
}

type System = ReturnType<typeof openSystem>;

async function seed(system: System, directory: string) {
  await system.dispatch({
    type: "project.create",
    commandId: CommandId.make("project"),
    projectId,
    title: "Handoff",
    workspaceRoot: directory,
    createdAt,
  });
  await system.dispatch({
    type: "thread.create",
    commandId: CommandId.make("thread"),
    threadId,
    projectId,
    title: "Source",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "repair/source",
    worktreePath: directory,
    createdAt,
  });
  await system.dispatch(turn);
  await startTurn(system, turnId);
}

function startTurn(system: System, id: TurnId) {
  return system.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`session:${id}`),
    threadId,
    createdAt,
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: id,
      lastError: null,
      updatedAt: createdAt,
    },
  });
}

function question(system: System, requestId: ApprovalRequestId, id: TurnId) {
  return system.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(`question:${requestId}`),
    threadId,
    createdAt,
    activity: {
      id: EventId.make(`question:${requestId}`),
      kind: "user-input.requested",
      tone: "info",
      summary: "A question",
      turnId: id,
      createdAt,
      payload: {
        requestId,
        responseMode: "message",
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Which one?",
            options: [{ label: "A", description: "First" }],
          },
        ],
      },
    },
  });
}

const answer = (requestId: ApprovalRequestId) =>
  ({
    type: "thread.user-input.respond",
    commandId: CommandId.make(`answer:${requestId}`),
    threadId,
    requestId,
    answers: { choice: "A" },
    createdAt,
  }) satisfies OrchestrationCommand;

describe("thread handoff admission", () => {
  it("rejects every author mutation and plan-source bypass without appending its events", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "t3-handoff-mutations-"),
    );
    const system = openSystem(directory);
    try {
      await seed(system, directory);
      const targetId = ThreadId.make("other-thread");
      const planId = OrchestrationProposedPlanId.make("source-plan");
      await system.dispatch({
        type: "thread.create",
        commandId: CommandId.make("other-thread"),
        threadId: targetId,
        projectId,
        title: "Other",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      await system.dispatch({
        type: "thread.proposed-plan.upsert",
        commandId: CommandId.make("source-plan"),
        threadId,
        proposedPlan: {
          id: planId,
          turnId,
          planMarkdown: "Implement the fix",
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      });
      const receipt = await system.dispatch(begin);
      const before = await system.events();
      const forbidden = [
        { ...turn, commandId: CommandId.make("new-turn") },
        {
          ...turn,
          commandId: CommandId.make("new-plan"),
          threadId: targetId,
          sourceProposedPlan: { threadId, planId },
        },
        {
          type: "thread.meta.update",
          commandId: CommandId.make("branch"),
          threadId,
          branch: "other",
        },
        {
          type: "thread.meta.update",
          commandId: CommandId.make("worktree"),
          threadId,
          worktreePath: "/tmp/elsewhere",
        },
        {
          type: "thread.meta.update",
          commandId: CommandId.make("model"),
          threadId,
          modelSelection,
        },
        {
          type: "thread.meta.update",
          commandId: CommandId.make("regenerate"),
          threadId,
          regenerateTitle: true,
        },
        {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("runtime"),
          threadId,
          runtimeMode: "approval-required",
          createdAt,
        },
        {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("interaction"),
          threadId,
          interactionMode: "plan",
          createdAt,
        },
        {
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("revert"),
          threadId,
          turnCount: 0,
          createdAt,
        },
        { type: "thread.delete", commandId: CommandId.make("delete"), threadId },
        {
          type: "project.delete",
          commandId: CommandId.make("delete-project"),
          projectId,
          force: true,
        },
        {
          type: "project.meta.update",
          commandId: CommandId.make("move-project"),
          projectId,
          workspaceRoot: "/tmp/other",
        },
      ] satisfies OrchestrationCommand[];
      for (const command of forbidden) {
        await expect(system.dispatch(command)).rejects.toMatchObject({
          detail: expect.stringContaining("paused"),
        });
      }
      expect(await system.events()).toEqual(before);
      await system.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("title"),
        threadId,
        title: "Readable source",
      });
      await system.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("interrupt"),
        threadId,
        turnId,
        createdAt,
      });
      await system.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("stop"),
        threadId,
        createdAt,
      });
      const source = (await system.snapshot()).threads.find((entry) => entry.id === threadId);
      expect(source?.handoff).toEqual({
        status: "fenced",
        handoffId: begin.commandId,
        admissionSequence: receipt.sequence,
      });
      expect(
        source?.messages
          .filter((message) => message.role === "user")
          .map((message) => message.text),
      ).toEqual(["Original work"]);
      expect(source?.proposedPlans[0]?.implementationThreadId).toBeNull();
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("retains begin receipts through cancellation and restart without reopening another fence", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-restart-"));
    let system = openSystem(directory);
    try {
      await seed(system, directory);
      const [receipt, duplicate] = await Promise.all([
        system.dispatch(begin),
        system.dispatch(begin),
      ]);
      expect(duplicate).toEqual(receipt);
      await system.dispose();
      system = openSystem(directory);
      expect(await system.dispatch(begin)).toEqual(receipt);
      expect((await system.snapshot()).threads[0]?.handoff?.handoffId).toBe(begin.commandId);
      const cancel = {
        type: "thread.handoff.cancel",
        commandId: CommandId.make("cancel"),
        threadId,
        handoffId: begin.commandId,
      } satisfies OrchestrationCommand;
      const canceled = await system.dispatch(cancel);
      await system.dispose();
      system = openSystem(directory);
      expect(await system.dispatch(cancel)).toEqual(canceled);
      expect(await system.dispatch(begin)).toEqual(receipt);
      expect((await system.snapshot()).threads[0]?.handoff).toBeNull();
      await system.dispatch({
        ...turn,
        commandId: CommandId.make("resumed"),
        message: { ...turn.message, messageId: MessageId.make("resumed"), text: "Resumed" },
      });
      const nextBegin = { ...begin, commandId: CommandId.make("next-handoff") };
      await system.dispatch(nextBegin);
      await system.dispose();
      system = openSystem(directory);
      expect(await system.dispatch(cancel)).toEqual(canceled);
      expect(await system.dispatch(begin)).toEqual(receipt);
      await expect(
        system.dispatch({ ...cancel, commandId: CommandId.make("stale-cancel") }),
      ).rejects.toMatchObject({ detail: expect.stringContaining("no longer matches") });
      expect((await system.snapshot()).threads[0]?.handoff?.handoffId).toBe(nextBegin.commandId);
      expect(
        (await system.events()).filter((event) => event.type === "thread.handoff-begun"),
      ).toHaveLength(2);
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("admits durable correlated answers and their descendants after restart while rejecting forgeries", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-answers-"));
    let system = openSystem(directory);
    try {
      await seed(system, directory);
      const approvalId = ApprovalRequestId.make("approval");
      const first = ApprovalRequestId.make("first-question");
      await system.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("approval"),
        threadId,
        createdAt,
        activity: {
          id: EventId.make("approval"),
          kind: "approval.requested",
          tone: "info",
          summary: "Allow?",
          turnId,
          createdAt,
          payload: { requestId: approvalId },
        },
      });
      await question(system, first, turnId);
      await system.dispatch(begin);
      await system.dispose();
      system = openSystem(directory);
      await system.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("approve"),
        threadId,
        requestId: approvalId,
        decision: "accept",
        createdAt,
      });
      await expect(
        system.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.make("approve-again"),
          threadId,
          requestId: approvalId,
          decision: "accept",
          createdAt,
        }),
      ).rejects.toMatchObject({ detail: expect.stringContaining("not tied") });
      await system.dispatch(answer(first));
      const nextTurn = TurnId.make("answer-turn");
      await startTurn(system, nextTurn);
      const second = ApprovalRequestId.make("second-question");
      await question(system, second, nextTurn);
      await system.dispose();
      system = openSystem(directory);
      await system.dispatch(answer(second));
      const events = await system.events();
      expect(
        events
          .filter((event) => event.type === "thread.turn-start-requested")
          .map((event) => event.metadata),
      ).toEqual([
        {},
        { handoffId: begin.commandId, requestId: first },
        { handoffId: begin.commandId, requestId: second },
      ]);
      const forged = decodeClientCommand({
        ...turn,
        commandId: "forged",
        message: { ...turn.message, messageId: `async-answer:${first}` },
        metadata: { handoffId: begin.commandId },
        handoffResponse: {
          handoffId: begin.commandId,
          threadId,
          commandId: "forged",
          requestId: first,
        },
      });
      expect(forged).not.toHaveProperty("metadata");
      expect(forged).not.toHaveProperty("handoffResponse");
      await expect(system.dispatch(decodeCommand(forged))).rejects.toMatchObject({
        detail: expect.stringContaining("paused"),
      });
      const unknown = ApprovalRequestId.make("uncorrelated");
      await question(system, unknown, TurnId.make("unknown-turn"));
      await expect(system.dispatch(answer(unknown))).rejects.toMatchObject({
        detail: expect.stringContaining("not tied"),
      });
      expect(
        (await system.events()).filter((event) => event.type === "thread.turn-start-requested"),
      ).toHaveLength(3);
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a persisted response lineage marker from a different fence", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-handoff-foreign-"));
    let system = openSystem(directory);
    try {
      await seed(system, directory);
      const receipt = await system.dispatch(begin);
      const template = (await system.events()).find(
        (event) => event.type === "thread.turn-start-requested",
      );
      if (template === undefined) throw new Error("Missing original turn intent");
      const { sequence, ...original } = template;
      expect(sequence).toBeLessThan(receipt.sequence);
      const foreign = await system.appendEvent({
        ...original,
        eventId: EventId.make("foreign-response"),
        commandId: CommandId.make("foreign-response"),
        metadata: {
          handoffId: CommandId.make("other-fence"),
          requestId: ApprovalRequestId.make("foreign-question"),
        },
        payload: { ...original.payload, messageId: MessageId.make("foreign-response") },
      });
      expect(foreign.sequence).toBeGreaterThan(receipt.sequence);
      await system.dispose();
      system = openSystem(directory);
      const foreignTurn = TurnId.make("foreign-turn");
      await startTurn(system, foreignTurn);
      const requestId = ApprovalRequestId.make("foreign-followup");
      await question(system, requestId, foreignTurn);
      await expect(system.dispatch(answer(requestId))).rejects.toMatchObject({
        detail: expect.stringContaining("not tied"),
      });
      expect((await system.snapshot()).threads[0]?.handoff?.handoffId).toBe(begin.commandId);
    } finally {
      await system.dispose();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
