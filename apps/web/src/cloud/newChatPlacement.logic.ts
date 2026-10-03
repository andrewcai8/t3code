import { newChatProject, type NewChatEnvironmentState } from "@t3tools/client-runtime/cloud";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

/**
 * A project picker entry's target, placed like a new chat when the picker knows the environments'
 * state; otherwise the entry's own pick.
 */
export function placeNewChatProject<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(
  requested: Project | undefined,
  group: { readonly memberProjects: ReadonlyArray<Project>; readonly projectKey: string },
  environmentState:
    | ((environmentId: EnvironmentId) => NewChatEnvironmentState | null | undefined)
    | undefined,
): Project | null | undefined {
  if (!environmentState || !requested) return requested;
  return newChatProject({
    requested: scopeProjectRef(requested.environmentId, requested.id),
    projects: group.memberProjects,
    logicalProjectKey: () => group.projectKey,
    environmentState,
  });
}
