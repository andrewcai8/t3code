import { type DraftId, type DraftThreadState, useComposerDraftStore } from "../composerDraftStore";
import {
  type PendingCloudEnvironmentSend,
  pendingEnvironmentSendsEqual,
} from "./pendingCloudSendSchema";

/**
 * Records a draft's first cloud send once it has left the composer, or clears it with null. It
 * survives an empty prompt, so the sidebar and new-thread remap treat the draft as invested work
 * until the turn lands or the user cancels. A draft that is gone is left alone.
 */
export function setDraftPendingEnvironmentSend(
  draftId: DraftId,
  pending: PendingCloudEnvironmentSend | null,
): void {
  useComposerDraftStore.setState((state) => {
    const existing = state.draftThreadsByThreadKey[draftId];
    if (!existing || pendingEnvironmentSendsEqual(existing.pendingEnvironmentSend, pending)) {
      return state;
    }
    const next: DraftThreadState = { ...existing };
    if (pending === null) {
      delete next.pendingEnvironmentSend;
    } else {
      next.pendingEnvironmentSend = pending;
    }
    return { draftThreadsByThreadKey: { ...state.draftThreadsByThreadKey, [draftId]: next } };
  });
}

export function patchDraftPendingEnvironmentSend(
  draftId: DraftId,
  patch: Partial<PendingCloudEnvironmentSend>,
): void {
  const current = useComposerDraftStore.getState().getDraftSession(draftId)?.pendingEnvironmentSend;
  if (!current) return;
  setDraftPendingEnvironmentSend(draftId, { ...current, ...patch });
}
