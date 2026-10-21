import {
  CommandId,
  DEFAULT_CONTINUATION_PROMPT,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeAccountRouting } from "./accountRouting.ts";
import { accountSwitchContinuation } from "./accountSwitchContinuation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  prompt = DEFAULT_CONTINUATION_PROMPT,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  return continuation(
    thread.id,
    thread.latestRunId,
    `limit-resume:${identity}:${recovery.requestId ?? "legacy"}`,
    recovery.requestId,
    prompt,
  );
}

/**
 * The continuation that moves a limited run to whichever account routing picks, right after the
 * sweep armed its recovery with `arm`. It carries the thread's own selection, so
 * `ThreadManagementService.dispatch` routes it like any follow-up.
 */
function limitSwitchCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  arm: {
    readonly commandId: CommandId;
    readonly limitRecovery: OrchestrationV2LimitRecoveryUpdate;
  },
  prompt: string,
): OrchestrationV2Command {
  const { runId, resetAt } = arm.limitRecovery;
  return {
    ...continuation(
      thread.id,
      runId,
      `limit-switch:${thread.id}:${runId}:${Date.parse(resetAt)}`,
      arm.commandId,
      accountSwitchContinuation(prompt),
    ),
    modelSelection: thread.modelSelection,
  };
}

const continuation = (
  threadId: ThreadId,
  runId: RunId,
  id: string,
  requestId: CommandId | undefined,
  text: string,
) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(id),
    messageId: MessageId.make(id),
    threadId,
    usageLimitContinuationOfRunId: runId,
    ...(requestId === undefined ? {} : { usageLimitRecoveryRequestId: requestId }),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  }) satisfies OrchestrationV2Command;

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const routeAccount = yield* makeAccountRouting;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of candidates) {
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
        preferences.continuationPrompt,
      );
      if (command === null) continue;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          const moves =
            command.limitRecovery.autoResume === true &&
            (yield* routeAccount({
              projectId: thread.projectId,
              selection: thread.modelSelection,
              current: thread.modelSelection.instanceId,
            }).pipe(Effect.orElseSucceed(() => thread.modelSelection))).instanceId !==
              thread.modelSelection.instanceId;
          // Arming first marks the run handled, so a sweep after a crash never moves it twice.
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            // A snooze until the spent account resets would hold the moved chat back too.
            limitRecovery: moves
              ? { ...command.limitRecovery, snooze: false }
              : command.limitRecovery,
          });
          if (moves)
            yield* threads.dispatch(
              limitSwitchCommand(
                thread,
                { commandId: command.commandId, limitRecovery: command.limitRecovery },
                preferences.continuationPrompt,
              ),
            );
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
