import {
  cloneRepository,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { PendingCloudEnvironmentSend } from "./pendingCloudSendSchema";

/**
 * The driver and model a cloud chat's draft carries onto the environment it provisions.
 * The box keys its one account per driver by the driver's default instance id, not the
 * manager's account id, so the selection moves to that key. The model is not checked
 * against the manager's catalog: the box runs the chat and resolves it against its own.
 */
export function buildCloudHandoff(input: {
  agentDriver: ProviderDriverKind;
  selection: ModelSelection;
}): { agentDriver: ProviderDriverKind; modelSelection: ModelSelection } {
  return {
    agentDriver: input.agentDriver,
    modelSelection: createModelSelection(
      defaultInstanceIdForDriver(input.agentDriver),
      input.selection.model,
      input.selection.options,
    ),
  };
}

/**
 * What a cloud chat clones: the project's repository, on the branch the user
 * picked. Without a pick the branch is left out and the box asks GitHub for the
 * default, which a stale local origin/HEAD cannot get wrong.
 */
export function cloudCloneSource(
  identity: RepositoryIdentity | null | undefined,
  branch: string | null,
): { readonly repository?: string; readonly branch?: string } {
  const repository = cloneRepository(identity);
  if (!repository) return {};
  return branch ? { repository, branch } : { repository };
}

/**
 * Whether auto balance must pick a machine: it has not picked one, or its pick
 * no longer takes new chats (such as a host whose local agent runs were
 * switched off after the pick).
 */
export function needsLoadBalancedPick(input: {
  readonly automatic: boolean;
  readonly pickedEnvironmentId: EnvironmentId | null | undefined;
  readonly candidates: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
}): boolean {
  if (!input.automatic) return false;
  const picked = input.pickedEnvironmentId;
  return !picked || !input.candidates.some((candidate) => candidate.environmentId === picked);
}

/**
 * Whether a draft points at a cloud box it did not start, as one opened from another chat's box
 * before boxes were marked. Such a box is not the draft's: it neither connects for it nor shows,
 * and the draft moves to its project's copy on a user environment.
 */
export function isDraftOnAnotherChatsBox(input: {
  readonly draftId: string | null;
  readonly environmentId: EnvironmentId | null;
  /** The box the draft's own cloud send started, once it is ready. */
  readonly ownBoxEnvironmentId: string | null;
  readonly boxIds: ReadonlySet<EnvironmentId>;
}): boolean {
  return (
    input.draftId !== null &&
    input.environmentId !== null &&
    input.environmentId !== input.ownBoxEnvironmentId &&
    input.boxIds.has(input.environmentId)
  );
}

export function isInProgressCloudProvisioningPhase(
  phase: PendingCloudEnvironmentSend["phase"] | null,
): boolean {
  return phase === "creating" || phase === "pairing" || phase === "loading-project";
}

export function pendingCloudSendPreview(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 0 ? line : "Preparing environment";
}
