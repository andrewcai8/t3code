import {
  composerDraftHasUserContent,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

/**
 * A first cloud send can clear the composer while its machine is still preparing. That draft is
 * still invested work: it belongs in the sidebar, survives remap, and is never reused as an empty
 * new-thread target.
 */
export function draftSessionHasInvestedWork(
  session: DraftSessionState | null | undefined,
  composer?: ComposerThreadDraftState | null,
): boolean {
  return session?.pendingEnvironmentSend != null || composerDraftHasUserContent(composer);
}
