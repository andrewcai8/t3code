import { describe, expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

import { buildPendingNewTasks } from "./pending-new-tasks-model";
import { withoutArrivedCreations } from "./pending-new-task-arrivals";
import { flattenQueuedThreadMessages, type QueuedThreadMessage } from "./thread-outbox-model";

const environmentId = EnvironmentId.make("env-1");

function queuedCreation(id: string): QueuedThreadMessage {
  return {
    environmentId,
    threadId: ThreadId.make(`thread-${id}`),
    messageId: MessageId.make(id),
    commandId: CommandId.make(`command-${id}`),
    text: `queued ${id}`,
    attachments: [],
    createdAt: "2026-09-05T10:00:00.000Z",
    creation: {
      projectId: ProjectId.make("project-1"),
      workspaceMode: "local",
      branch: "main",
      worktreePath: null,
    },
  };
}

describe("withoutArrivedCreations", () => {
  it("drops a queued creation from the pending tasks once its thread exists", () => {
    const queued = { [`${environmentId}:thread-a`]: [queuedCreation("a")] };
    const listed = (threadIds: ReadonlyArray<string>) =>
      buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(
          withoutArrivedCreations(
            queued,
            threadIds.map((threadId) => ({ environmentId, threadId: ThreadId.make(threadId) })),
          ),
        ),
        drafts: {},
      }).map((task) => task.title);

    expect(listed([])).toEqual(["queued a"]);
    expect(listed(["thread-a"])).toEqual([]);
  });
});
