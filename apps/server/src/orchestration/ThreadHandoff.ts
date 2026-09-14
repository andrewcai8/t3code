import type { CommandId, OrchestrationCommand, OrchestrationReadModel } from "@t3tools/contracts";

export type HandoffResponse = Pick<
  Extract<OrchestrationCommand, { type: "thread.user-input.respond" }>,
  "threadId" | "commandId" | "requestId"
> & { readonly handoffId: CommandId };

export function handoffRejection(
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  response?: HandoffResponse,
): string | undefined {
  const thread =
    "threadId" in command
      ? readModel.threads.find((entry) => entry.id === command.threadId)
      : undefined;
  const description = "New work is paused while this thread is being handed off.";
  if (
    command.type === "thread.turn.start" &&
    command.sourceProposedPlan !== undefined &&
    readModel.threads.some(
      (entry) => entry.id === command.sourceProposedPlan?.threadId && entry.handoff != null,
    )
  )
    return description;
  if (
    (command.type === "project.delete" ||
      (command.type === "project.meta.update" && command.workspaceRoot !== undefined)) &&
    readModel.threads.some(
      (entry) =>
        entry.projectId === command.projectId && entry.deletedAt === null && entry.handoff != null,
    )
  )
    return description;
  if (thread?.handoff == null) return;
  const correlated =
    response?.threadId === thread.id &&
    response.commandId === command.commandId &&
    response.handoffId === thread.handoff.handoffId;

  switch (command.type) {
    case "thread.turn.start":
      return correlated &&
        command.sourceProposedPlan === undefined &&
        command.message.messageId === `async-answer:${response.requestId}`
        ? undefined
        : description;
    case "thread.approval.respond":
    case "thread.user-input.respond":
    case "thread.user-input.dismiss":
      return correlated && command.requestId === response.requestId
        ? undefined
        : "This response is not tied to pending work admitted before the handoff.";
    case "thread.meta.update":
      return command.branch !== undefined ||
        command.worktreePath !== undefined ||
        command.modelSelection !== undefined ||
        command.regenerateTitle === true
        ? description
        : undefined;
    case "thread.create":
    case "thread.delete":
    case "thread.checkpoint.revert":
    case "thread.conversation.revert":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
      return description;
    case "project.create":
    case "project.delete":
    case "project.meta.update":
    case "thread.handoff.begin":
    case "thread.handoff.cancel":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.turn.interrupt":
    case "thread.session.stop":
    case "thread.session.set":
    case "thread.message.assistant.delta":
    case "thread.message.assistant.complete":
    case "thread.history.import":
    case "thread.proposed-plan.upsert":
    case "thread.turn.diff.complete":
    case "thread.revert.complete":
    case "thread.activity.append":
      return;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
