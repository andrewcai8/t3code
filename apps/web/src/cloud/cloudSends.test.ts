import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DraftId,
  type PendingCloudEnvironmentSend,
  useComposerDraftStore,
} from "../composerDraftStore";
import { recordCloudSendStep } from "./cloudSends";

const draftId = DraftId.make("draft");
const codex = ProviderInstanceId.make("codex");
const localProject = scopeProjectRef(EnvironmentId.make("laptop"), ProjectId.make("repo"));
const boxProject = scopeProjectRef(EnvironmentId.make("box"), ProjectId.make("box-repo"));
const settingUp: PendingCloudEnvironmentSend = {
  provider: "e2b",
  preview: "fix the flaky test",
  messageId: "message",
  createdAt: "2026-09-29T19:37:38.000Z",
  prompt: "fix the flaky test",
  outgoingMessageText: "fix the flaky test",
  phase: "pairing",
  startedAt: "2026-09-29T19:37:38.000Z",
  modelSelection: { instanceId: codex, model: "gpt-5.5" },
};

function draftSettingUp() {
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId(localProject, draftId, {
    threadId: ThreadId.make("thread"),
    envMode: "worktree",
    branch: "main",
  });
  store.setDraftPendingEnvironmentSend(draftId, settingUp);
}

function draft() {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  return {
    project: session ? `${session.environmentId}/${session.projectId}` : null,
    envMode: session?.envMode,
    branch: session?.branch,
    pending: session?.pendingEnvironmentSend ?? null,
    model: store.getComposerDraft(draftId)?.modelSelectionByProvider[codex] ?? null,
  };
}

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
});

describe("recordCloudSendStep", () => {
  it("points a ready send's draft at the box's project, on the model it was sent with", () => {
    draftSettingUp();

    recordCloudSendStep(draftId, {
      kind: "ready",
      projectRef: boxProject,
      firstTurnStarted: false,
    });

    expect(draft()).toEqual({
      project: "box/box-repo",
      envMode: "local",
      branch: null,
      pending: { ...settingUp, phase: "ready", readyEnvironmentId: "box" },
      model: { instanceId: "codex", model: "gpt-5.5" },
    });
  });

  it("marks a ready send the host already started, so the page does not send it again", () => {
    draftSettingUp();

    recordCloudSendStep(draftId, { kind: "ready", projectRef: boxProject, firstTurnStarted: true });

    expect(draft().pending).toEqual({
      ...settingUp,
      phase: "ready",
      readyEnvironmentId: "box",
      hostStartedFirstTurn: true,
    });
  });

  it("shows why setup failed, and keeps the send to resume", () => {
    draftSettingUp();

    recordCloudSendStep(draftId, { kind: "failed", message: "The machine was stopped." });

    expect(draft().pending).toEqual({
      ...settingUp,
      phase: "failed",
      error: "The machine was stopped.",
      endedAt: expect.any(String),
    });
    expect(draft().project).toBe("laptop/repo");
  });

  it("clears a send that is over, leaving the draft where it was", () => {
    draftSettingUp();

    recordCloudSendStep(draftId, { kind: "cancelled" });

    expect(draft()).toEqual({
      project: "laptop/repo",
      envMode: "worktree",
      branch: "main",
      pending: null,
      model: null,
    });
  });
});
