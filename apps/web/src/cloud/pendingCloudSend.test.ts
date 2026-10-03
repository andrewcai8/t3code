import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  composerDraftHasUserContent,
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { draftSessionHasInvestedWork } from "./draftInvestedWork";
import { setDraftPendingEnvironmentSend } from "./pendingCloudSend";
import type { PendingCloudEnvironmentSend } from "./pendingCloudSendSchema";

const environmentId = EnvironmentId.make("environment-local");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-a"));
const otherProjectRef = scopeProjectRef(environmentId, ProjectId.make("project-b"));
const threadId = ThreadId.make("thread-a");
const otherThreadId = ThreadId.make("thread-b");
const draftId = DraftId.make("draft-a");
const otherDraftId = DraftId.make("draft-b");

describe("a draft's pending cloud send", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({
      rewindingThreadKeys: new Set(),
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyOptionsByModelByProvider: {},
      stickyActiveProvider: null,
    });
  });

  it("keeps a pending environment send after composer clear and remap", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setPrompt(draftId, "start the sandbox");
    const pending: PendingCloudEnvironmentSend = {
      provider: "e2b",
      preview: "start the sandbox",
      messageId: "msg-pending",
      createdAt: "2026-09-14T00:00:00.000Z",
      prompt: "start the sandbox",
      outgoingMessageText: "start the sandbox",
      phase: "creating",
      startedAt: "2026-09-14T00:00:01.000Z",
      repository: "me/repo",
      branch: "feature",
    };
    setDraftPendingEnvironmentSend(draftId, pending);
    store.clearComposerContent(draftId);

    expect(
      composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(draftId)),
    ).toBe(false);
    expect(
      draftSessionHasInvestedWork(
        useComposerDraftStore.getState().getDraftSession(draftId),
        useComposerDraftStore.getState().getComposerDraft(draftId),
      ),
    ).toBe(true);

    store.setProjectDraftThreadId(projectRef, otherDraftId, { threadId: otherThreadId });

    expect(useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef)?.draftId).toBe(
      otherDraftId,
    );
    expect(
      useComposerDraftStore.getState().getDraftSession(draftId)?.pendingEnvironmentSend,
    ).toEqual(pending);

    const persisted = partializeComposerDraftStoreState(useComposerDraftStore.getState());
    expect(persisted.draftThreadsByThreadKey[draftId]?.pendingEnvironmentSend).toEqual(pending);
  });

  it("reloads an environment send cut off mid-setup as it was, for the page to pick back up", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, { threadId });
    store.setProjectDraftThreadId(otherProjectRef, otherDraftId, { threadId: otherThreadId });
    const pending: PendingCloudEnvironmentSend = {
      provider: "e2b",
      preview: "verify the harness",
      messageId: "msg-pending",
      createdAt: "2026-09-29T19:37:38.000Z",
      prompt: "verify the harness",
      outgoingMessageText: "verify the harness",
      phase: "pairing",
      startedAt: "2026-09-29T19:37:38.000Z",
      repository: "authentic-intelligence/megpt-mono",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.5",
      },
    };
    const ready: PendingCloudEnvironmentSend = {
      ...pending,
      messageId: "msg-ready",
      phase: "ready",
      readyEnvironmentId: "box-environment",
    };
    setDraftPendingEnvironmentSend(draftId, pending);
    setDraftPendingEnvironmentSend(otherDraftId, ready);

    const persistApi = useComposerDraftStore.persist as unknown as {
      getOptions: () => {
        merge: (
          persistedState: unknown,
          currentState: ReturnType<typeof useComposerDraftStore.getState>,
        ) => ReturnType<typeof useComposerDraftStore.getState>;
      };
    };
    const hydrated = persistApi
      .getOptions()
      .merge(
        partializeComposerDraftStoreState(useComposerDraftStore.getState()),
        useComposerDraftStore.getState(),
      );

    expect(hydrated.draftThreadsByThreadKey[draftId]?.pendingEnvironmentSend).toEqual({
      provider: "e2b",
      preview: "verify the harness",
      messageId: "msg-pending",
      createdAt: "2026-09-29T19:37:38.000Z",
      prompt: "verify the harness",
      outgoingMessageText: "verify the harness",
      phase: "pairing",
      startedAt: "2026-09-29T19:37:38.000Z",
      repository: "authentic-intelligence/megpt-mono",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.5",
      },
    });
    expect(hydrated.draftThreadsByThreadKey[otherDraftId]?.pendingEnvironmentSend).toEqual(ready);
  });
});
