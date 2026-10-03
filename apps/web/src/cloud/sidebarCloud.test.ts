import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarThreadStatus, resolveSidebarV2TopStatus } from "../components/Sidebar.logic";
import type { DraftSessionState } from "../composerDraftStore";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../types";
import type { PendingCloudEnvironmentSend } from "./pendingCloudSendSchema";
import { isCloudSendThreadListed, sidebarDraftStatusLabel } from "./sidebarCloud";

describe("a thread whose cloud machine was removed", () => {
  it("reports an expired workspace even when the cached runtime still says it is running", () => {
    const status = resolveSidebarThreadStatus(
      {
        hasPendingApprovals: true,
        hasPendingUserInput: false,
        runtime: {
          status: "running",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-03-09T10:00:00.000Z",
        },
      },
      {
        phase: "error",
        error: "Machine removed",
        traceId: null,
        blockedReason: "workspace-missing",
      },
    );
    expect(status).toBe("expired");
    expect(resolveSidebarV2TopStatus({ status, isUnread: true, isWoke: true })).toBe("expired");
  });
});

describe("a draft row for a cloud first send", () => {
  const readySend: PendingCloudEnvironmentSend = {
    provider: "e2b",
    preview: "fix the flaky test",
    messageId: "message-cloud",
    createdAt: "2026-09-27T10:00:00.000Z",
    prompt: "fix the flaky test",
    outgoingMessageText: "fix the flaky test",
    phase: "ready",
    startedAt: "2026-09-27T10:00:00.000Z",
    readyEnvironmentId: "environment-cloud",
  };
  const unsent: DraftSessionState = {
    threadId: ThreadId.make("thread-cloud"),
    environmentId: EnvironmentId.make("environment-cloud"),
    projectId: ProjectId.make("project-cloud"),
    logicalProjectKey: "project-cloud",
    createdAt: "2026-09-27T10:00:00.000Z",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    envMode: "local",
    startFromOrigin: false,
  };
  const inPhase = (phase: PendingCloudEnvironmentSend["phase"]): DraftSessionState => ({
    ...unsent,
    pendingEnvironmentSend: { ...readySend, phase },
  });

  it("gives way to the box's thread once it exists", () => {
    const threadKey = "environment-cloud:thread-cloud";
    expect(isCloudSendThreadListed(inPhase("ready"), new Set())).toBe(false);
    expect(isCloudSendThreadListed(inPhase("ready"), new Set([threadKey]))).toBe(true);
    expect(isCloudSendThreadListed(unsent, new Set([threadKey]))).toBe(false);
  });

  it("is labeled by its live send and whether it is open", () => {
    expect(sidebarDraftStatusLabel(unsent, true)).toBe("Unsent draft");
    expect(sidebarDraftStatusLabel(inPhase("creating"), true)).toBe("Starting cloud machine…");
    expect(sidebarDraftStatusLabel(inPhase("creating"), false)).toBe("Starting cloud machine…");
    expect(sidebarDraftStatusLabel(inPhase("ready"), true)).toBe("Sending…");
    // Parked, or left after a failed turn start: the held send is not going out.
    expect(sidebarDraftStatusLabel(inPhase("ready"), false)).toBe("Unsent draft");
    expect(sidebarDraftStatusLabel(inPhase("failed"), true)).toBe("Unsent draft");
  });
});
