import { useAtomValue } from "@effect/atom-react";
import {
  cloudMachineStatus,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CloudMachineState, EnvironmentId } from "@t3tools/contracts";

import {
  type ComposerThreadDraftState,
  type DraftId,
  type DraftSessionState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { discardComposerDraft } from "../lib/discardComposerDraft";

export { environmentAllowsThreadSettlement } from "@t3tools/client-runtime/state/thread-settled";
export { useEnvironment } from "../state/environments";
export { useThreadRefs } from "../state/entities";
export { stopProvisionedCloudMachineMenuItem } from "./cloudThreadMenu";
export { draftSessionHasInvestedWork } from "./draftInvestedWork";
export { provisionedSandboxFor } from "./provisionedSandboxLeases";
export { useCloudThreadActions } from "./useCloudThreadActions";

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
 * Discards a sidebar draft row. A cloud first send clears the composer before its draft settles,
 * which leaves `discardComposerDraft` nothing to undo, so that row's session is dropped directly.
 */
export function discardDraftRow(draftId: DraftId): void {
  const store = useComposerDraftStore.getState();
  if (store.getComposerDraft(draftId) === null) {
    store.clearDraftThread(draftId);
    return;
  }
  discardComposerDraft(draftId);
}

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

/** Whether a chat's cloud machine is asleep, waking or updating; null while awake or not a box. */
export function useCloudMachineStatus(
  environmentId: EnvironmentId,
  connection: EnvironmentConnectionPresentation | undefined,
): CloudMachineState | null {
  const machine = useAtomValue(environmentCatalog.cloudMachineAtom(environmentId));
  return cloudMachineStatus(machine ?? undefined, connection?.phase);
}
