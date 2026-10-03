import { newChatProject } from "@t3tools/client-runtime/cloud";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ScopedProjectRef } from "@t3tools/contracts";

import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "../logicalProject";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";

/**
 * Where a new chat asked for `requested` opens: that project, or its copy on a user environment
 * a new chat can run on (see `newChatProject`), read from the environments as they are now. A
 * project whose create event has not landed yet opens as asked. Null when only cloud boxes hold
 * the project.
 */
export function placeNewChat(
  requested: ScopedProjectRef,
  projects: ReadonlyArray<EnvironmentProject>,
  projectGroupingSettings: ProjectGroupingSettings,
): ScopedProjectRef | null {
  const environments = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  const target = newChatProject({
    requested,
    projects,
    logicalProjectKey: (project) =>
      deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
    environmentState: (environmentId) => environments.get(environmentId),
  });
  if (target) return scopeProjectRef(target.environmentId, target.id);
  const isKnownProject = projects.some(
    (project) =>
      project.environmentId === requested.environmentId && project.id === requested.projectId,
  );
  return isKnownProject ? null : requested;
}
