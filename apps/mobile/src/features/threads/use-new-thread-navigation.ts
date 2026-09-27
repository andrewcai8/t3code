import { useNavigation } from "@react-navigation/native";
import { boxesOfOtherChats } from "@t3tools/client-runtime/cloud";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import { readProject, useServerConfigs } from "../../state/entities";
import { resolveNewThreadStart } from "./new-task-project-selection";
import { useProvisionedBoxes } from "./use-provisioned-boxes";

/**
 * "New thread in project" and "New thread on branch". On a host that runs no agents but can
 * provision, or on another chat's box, both start a cloud machine on the host instead of a draft
 * the host would refuse or the box already runs. The latest configs and boxes are read when a
 * callback runs, so the callbacks stay stable for the layouts using them.
 */
export function useNewThreadNavigation() {
  const navigation = useNavigation();
  const serverConfigs = useServerConfigs();
  const provisionedBoxes = useProvisionedBoxes(serverConfigs);
  const boxes = useMemo(() => boxesOfOtherChats(provisionedBoxes, null), [provisionedBoxes]);
  const latest = useRef({ serverConfigs, boxes });
  useLayoutEffect(() => {
    latest.current = { serverConfigs, boxes };
  }, [serverConfigs, boxes]);

  const newThreadInProject = useCallback(
    (project: EnvironmentProject) => {
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
      const project = readProject({
        environmentId: thread.environmentId,
        projectId: thread.projectId,
      });
      const start = project ? resolveNewThreadStart({ project, ...latest.current }) : null;
      if (start?.kind === "cloud-machine") {
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
