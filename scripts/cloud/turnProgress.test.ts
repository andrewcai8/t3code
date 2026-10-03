import {
  EventId,
  MessageId,
  ProviderInstanceId,
  RunId,
  TurnItemId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  v2Now,
  v2Projection,
  v2ThreadId,
} from "../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { advanceTurn, initialProgress, type TurnProgress } from "./turnProgress.ts";

const sent = MessageId.make("sent");
const instanceId = ProviderInstanceId.make("codex");

const run = (
  id: string,
  userMessageId: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): OrchestrationV2Run => ({
  id: RunId.make(id),
  threadId: v2ThreadId,
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5" },
  providerThreadId: null,
  userMessageId: MessageId.make(userMessageId),
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
});

const reply = (id: string, runId: string, text: string): OrchestrationV2ConversationMessage => ({
  createdBy: "agent",
  creationSource: "provider",
  id: MessageId.make(id),
  threadId: v2ThreadId,
  runId: RunId.make(runId),
  nodeId: null,
  role: "assistant",
  text,
  attachments: [],
  streaming: false,
  createdAt: v2Now,
  updatedAt: v2Now,
});

const failure = (runId: string, message: string): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(`error-${runId}`),
  threadId: v2ThreadId,
  runId: RunId.make(runId),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "failed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
  type: "error",
  failure: { class: "provider_error", message, code: null, retryable: false },
});

const snapshot = (
  snapshotSequence: number,
  parts: Partial<Pick<typeof v2Projection, "runs" | "messages" | "turnItems">> = {},
): OrchestrationV2ThreadStreamItem => ({
  kind: "snapshot",
  snapshotSequence,
  projection: { ...v2Projection, ...parts },
});

const event = (
  sequence: number,
  change:
    | { readonly type: "run.created" | "run.updated"; readonly payload: OrchestrationV2Run }
    | { readonly type: "message.updated"; readonly payload: OrchestrationV2ConversationMessage }
    | { readonly type: "turn-item.updated"; readonly payload: OrchestrationV2TurnItem },
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-${sequence}`),
    threadId: v2ThreadId,
    occurredAt: v2Now,
    ...change,
  },
});

const fold = (items: ReadonlyArray<readonly [OrchestrationV2ThreadStreamItem, number]>) =>
  items.reduce<TurnProgress>(
    (progress, [item, now]) => advanceTurn(progress, item, sent, now),
    initialProgress,
  );

const summary = (progress: TurnProgress) => ({
  reply: [...progress.assistant.values()].join("\n"),
  firstOutputAt: progress.firstOutputAt,
  completedAt: progress.completedAt,
  error: progress.error,
});

describe("advanceTurn", () => {
  it("times the sent message's run from its first reply to its completion", () => {
    const progress = fold([
      [snapshot(10, { runs: [run("earlier", "earlier-message", 1, "completed")] }), 100],
      [event(11, { type: "run.created", payload: run("ours", sent, 2, "running") }), 110],
      [event(12, { type: "message.updated", payload: reply("a1", "ours", "  ") }), 120],
      [
        event(13, { type: "message.updated", payload: reply("a1", "ours", "SMOKE_NONCE=abc") }),
        130,
      ],
      [event(14, { type: "run.updated", payload: run("ours", sent, 2, "completed") }), 140],
    ]);
    assert.deepStrictEqual(summary(progress), {
      reply: "SMOKE_NONCE=abc",
      firstOutputAt: 130,
      completedAt: 140,
      error: null,
    });
  });

  it("reads a turn that finished before the subscription opened from the snapshot alone", () => {
    const progress = fold([
      [
        snapshot(20, {
          runs: [
            run("earlier", "earlier-message", 1, "completed"),
            run("ours", sent, 2, "completed"),
          ],
          messages: [reply("old", "earlier", "not ours"), reply("a1", "ours", "done")],
        }),
        200,
      ],
    ]);
    assert.deepStrictEqual(summary(progress), {
      reply: "done",
      firstOutputAt: 200,
      completedAt: 200,
      error: null,
    });
  });

  it("reports a failed run with the provider's failure message", () => {
    const progress = fold([
      [snapshot(30, { runs: [run("ours", sent, 1, "running")] }), 300],
      [event(31, { type: "turn-item.updated", payload: failure("ours", "rate limited") }), 310],
      [event(32, { type: "run.updated", payload: run("ours", sent, 1, "failed") }), 320],
    ]);
    assert.deepStrictEqual(summary(progress), {
      reply: "",
      firstOutputAt: null,
      completedAt: 320,
      error: "rate limited",
    });
  });

  it("ignores events the snapshot already holds", () => {
    const progress = fold([
      [snapshot(40, { runs: [run("ours", sent, 1, "running")] }), 400],
      [event(40, { type: "run.updated", payload: run("ours", sent, 1, "completed") }), 410],
    ]);
    assert.deepStrictEqual(summary(progress), {
      reply: "",
      firstOutputAt: null,
      completedAt: null,
      error: null,
    });
  });
});
