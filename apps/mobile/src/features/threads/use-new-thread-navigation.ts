import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useCallback } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { resolveNewThreadStart } from "./new-task-project-selection";

/**
 * "New thread in project" and "New thread on branch". On a host that runs no agents but can
 * provision, both start a cloud machine for the project instead of a draft the host would refuse.
 */
export function useNewThreadNavigation() {
  const navigation = useNavigation();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();

  const newThreadInProject = useCallback(
    (project: EnvironmentProject) => {
      const start = resolveNewThreadStart(project, serverConfigs.get(project.environmentId));
      if (start.kind === "cloud-machine") {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskCloudMachine",
          params: {
            environmentId: String(project.environmentId),
            repository: start.repository,
            title: project.title,
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
    [navigation, serverConfigs],
  );

  const newThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      );
      const start = project
        ? resolveNewThreadStart(project, serverConfigs.get(project.environmentId))
        : null;
      if (project && start?.kind === "cloud-machine") {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskCloudMachine",
          params: {
            environmentId: String(project.environmentId),
            repository: start.repository,
            title: project.title,
            branch: thread.branch,
          },
        });
        return;
      }
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(thread.environmentId),
          projectId: String(thread.projectId),
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      });
    },
    [navigation, projects, serverConfigs],
  );

  return { newThreadInProject, newThreadOnBranch };
}
