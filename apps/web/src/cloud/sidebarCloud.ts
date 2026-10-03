import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ComposerThreadDraftState, DraftSessionState } from "../composerDraftStore";

/** The composer a draft row shows when its first cloud send already cleared the composer. */
export const EMPTY_SIDEBAR_COMPOSER: ComposerThreadDraftState = {
  prompt: "",
  images: [],
  files: [],
  nonPersistedImageIds: [],
  persistedAttachments: [],
  terminalContexts: [],
  previewAnnotations: [],
  reviewComments: [],
  threadContexts: [],
  modelSelectionByProvider: {},
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
};

/**
 * A cloud first-send keeps its draft until the local send settles, which can trail the box's
 * thread by a minute. Once that thread exists, its own row stands for the chat and the draft
 * gets none.
 */
export function isCloudSendThreadListed(
  session: DraftSessionState,
  knownThreadKeys: ReadonlySet<string>,
): boolean {
  return (
    session.pendingEnvironmentSend != null &&
    knownThreadKeys.has(scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)))
  );
}

// A first send stays a draft row until its thread exists, so while it is in
// flight the row names that step. A ready send only goes out from its open
// ChatView, and a failed turn start leaves the phase at ready, so a parked
// ready send is still unsent.
export function sidebarDraftStatusLabel(session: DraftSessionState, isOpen: boolean): string {
  switch (session.pendingEnvironmentSend?.phase) {
    case "creating":
    case "pairing":
    case "loading-project":
      return "Starting cloud machine…";
    case "ready":
      return isOpen ? "Sending…" : "Unsent draft";
    default:
      return "Unsent draft";
  }
}
