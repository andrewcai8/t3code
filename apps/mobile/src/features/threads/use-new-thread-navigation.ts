import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useCallback } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { resolveNewThreadProject } from "./new-task-project-selection";

/** Opens a new-thread draft in a project, on a machine a new chat can run on. */
export function useNewThreadNavigation() {
  const navigation = useNavigation();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();

  const newThreadInProject = useCallback(
    (requested: EnvironmentProject) => {
      const project = resolveNewThreadProject({ requested, projects, serverConfigs });
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project.environmentId),
          projectId: String(project.id),
          title: project.title,
        },
      });
    },
    [navigation, projects, serverConfigs],
  );

  const newThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      const requested = projects.find(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      );
      const project = requested
        ? resolveNewThreadProject({ requested, projects, serverConfigs })
        : null;
      const moved = project !== null && project.environmentId !== thread.environmentId;
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(project?.environmentId ?? thread.environmentId),
          projectId: String(project?.id ?? thread.projectId),
          branch: thread.branch,
          // A worktree path names a checkout on the thread's own machine.
          worktreePath: moved ? null : thread.worktreePath,
        },
      });
    },
    [navigation, projects, serverConfigs],
  );

  return { newThreadInProject, newThreadOnBranch };
}
