import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useCallback } from "react";

import { readProject, readServerConfig } from "../../state/entities";
import { resolveNewThreadStart } from "./new-task-project-selection";

/**
 * "New thread in project" and "New thread on branch". On a host that runs no agents but can
 * provision, both start a cloud machine for the project instead of a draft the host would refuse.
 * The store is read when a callback runs, so the callbacks stay stable for the layouts using them.
 */
export function useNewThreadNavigation() {
  const navigation = useNavigation();

  const newThreadInProject = useCallback(
    (project: EnvironmentProject) => {
      const start = resolveNewThreadStart(project, readServerConfig(project.environmentId));
      if (start.kind === "cloud-machine") {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskCloudMachine",
          params: {
            environmentId: String(project.environmentId),
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
      const project = readProject({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
      const start = project
        ? resolveNewThreadStart(project, readServerConfig(project.environmentId))
        : null;
      if (project && start?.kind === "cloud-machine") {
        navigation.navigate("NewTaskSheet", {
          screen: "NewTaskCloudMachine",
          params: {
            environmentId: String(project.environmentId),
            repository: start.repository,
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
    [navigation],
  );

  return { newThreadInProject, newThreadOnBranch };
}
