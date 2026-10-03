import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { AttachmentClaimError } from "./AttachmentClaims.ts";
import { launchRefusedForGood } from "./hostLaunchThread.ts";
import {
  OrchestratorCommandIdConflictError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorProjectionError,
} from "./Orchestrator.ts";
import { ThreadLaunchError } from "./ThreadLaunchService.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";

const commandId = CommandId.make("first-turn:request-1");
const threadId = ThreadId.make("thread-1");
const launchFailure = (cause: unknown) =>
  new ThreadLaunchError({
    operation: "create-thread",
    commandId,
    projectId: ProjectId.make("project-1"),
    threadId,
    cause,
  });

describe("launchRefusedForGood", () => {
  it("refuses launches the box will never accept and lets the host retry the rest", () => {
    const failures = [
      new AttachmentClaimError({ message: "Duplicate attachment ids are not allowed." }),
      launchFailure(
        new OrchestratorCommandIdConflictError({
          commandId,
          commandType: "thread.create",
          receiptThreadId: ThreadId.make("thread-other"),
          commandThreadId: threadId,
        }),
      ),
      launchFailure(
        new OrchestratorCommandPreviouslyRejectedError({
          commandId,
          commandType: "thread.create",
          detail: "Thread already exists.",
        }),
      ),
      launchFailure(new OrchestratorProjectionError({ threadId })),
      new ServerRuntimeStartupError({ mode: "web", host: null, port: 3000, cause: "not ready" }),
    ];
    expect(failures.map(launchRefusedForGood)).toEqual([true, true, true, false, false]);
  });
});
