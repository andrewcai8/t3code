import { useNavigation } from "@react-navigation/native";
import { newChatProject } from "@t3tools/client-runtime/cloud";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useRef } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { readProjects } from "../../state/cloud-entities";
import { useServerConfigs } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import { newChatPlacement, resolveNewThreadStart } from "./new-task-cloud-placement";
import { useOtherChatBoxes } from "./use-provisioned-boxes";

/** The copy of `environmentId`/`projectId`'s project a new thread opens on, never one on a box. */
function newThreadProject(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  latest: { readonly groupingSettings: ProjectGroupingSettings },
): EnvironmentProject | null {
  return newChatProject({
    requested: scopeProjectRef(environmentId, projectId),
    projects: readProjects(),
    logicalProjectKey: (project) =>
      deriveLogicalProjectKeyFromSettings(project, latest.groupingSettings),
    ...newChatPlacement(appAtomRegistry.get(environmentPresentations.presentationsAtom)),
  });
}

/**
 * "New thread in project" and "New thread on branch". Both open on the project's copy off any
 * box. On a host that runs no agents but can provision, they start a cloud machine on the host
 * instead of a draft the host would refuse. The latest configs and boxes are read when a callback
 * runs, so the callbacks stay stable for the layouts using them.
 */
export function useNewThreadNavigation() {
  const navigation = useNavigation();
  const serverConfigs = useServerConfigs();
  const groupingSettings = useMobileProjectGroupingSettings();
  const boxes = useOtherChatBoxes();
  const latest = useRef({ serverConfigs, boxes, groupingSettings });
  useLayoutEffect(() => {
    latest.current = { serverConfigs, boxes, groupingSettings };
  }, [serverConfigs, boxes, groupingSettings]);

  const newThreadInProject = useCallback(
    (requested: EnvironmentProject) => {
      const project = newThreadProject(requested.environmentId, requested.id, latest.current);
      if (!project) return;
      const start = resolveNewThreadStart({ project, ...latest.current });
      if (start.kind === "cloud-machine") {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskCloudMachine",
          params: {
            environmentId: String(start.managerId),
            repository: start.repository,
          },
        });
        return;
      }
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          title: project.title,
        },
      });
    },
    [navigation],
  );

  const newThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      const project = newThreadProject(thread.environmentId, thread.projectId, latest.current);
      if (!project) return;
      const start = resolveNewThreadStart({ project, ...latest.current });
      if (start.kind === "cloud-machine") {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskCloudMachine",
          params: {
            environmentId: String(start.managerId),
            repository: start.repository,
            branch: thread.branch,
          },
        });
        return;
      }
      // The thread's worktree is on its own machine, and its branch may not have reached this one.
      const moved = project.environmentId !== thread.environmentId;
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          branch: thread.branch,
          worktreePath: moved ? null : thread.worktreePath,
          ...(moved ? { branchOptional: "1" } : {}),
        },
      });
    },
    [navigation],
  );

  return { newThreadInProject, newThreadOnBranch };
}
