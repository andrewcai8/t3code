import { StackActions, useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { useBoxDemand } from "../../state/box-demand";
import { useServerConfigs } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  newChatPlacement,
  newTaskEnvironments,
  newTaskRunTargets,
  resolveNewTaskEnvironmentId,
  resolveNewThreadStart,
  type NewChatPlacement,
  type NewThreadStart,
} from "./new-task-cloud-placement";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import { useOtherChatBoxes } from "./use-provisioned-boxes";

export interface NewTaskCloud {
  /** Boxes other chats run on, each mapped to its host. A new task never starts on one. */
  readonly boxes: ReadonlyMap<EnvironmentId, EnvironmentId>;
  readonly placement: NewChatPlacement;
  /** How to leave another chat's box the flow was pointed at; null when it is on none. */
  readonly boxStart: NewThreadStart | null;
}

type NewTaskEnvironmentPick = Omit<NewTaskCloud, "boxStart"> & {
  readonly selectedEnvironmentId: EnvironmentId | null;
  /** The picked box another chat runs on, which the flow leaves; null when it is on none. */
  readonly blockedBox: EnvironmentId | null;
};

/**
 * The machine the new-task flow points at. A host that runs no agents still lists its projects,
 * but a new task starts elsewhere when anywhere else holds one. It starts on a box only when
 * picked there, as a fresh cloud machine's draft is, and that box stays connected meanwhile.
 */
export function useNewTaskEnvironmentPick(input: {
  readonly picked: EnvironmentId | null;
  /** A queued task being edited stays on its own machine, box or not. */
  readonly pinned: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): NewTaskEnvironmentPick {
  const serverConfigs = useServerConfigs();
  const boxes = useOtherChatBoxes();
  const { presentationById } = useEnvironments();
  const placement = useMemo(() => newChatPlacement(presentationById), [presentationById]);
  const selectedEnvironmentId = resolveNewTaskEnvironmentId({
    ...input,
    serverConfigs,
    boxes,
    placement,
  });
  useBoxDemand(selectedEnvironmentId);
  const blockedBox =
    input.picked !== null && !input.pinned && boxes.has(input.picked) ? input.picked : null;
  return { selectedEnvironmentId, boxes, placement, blockedBox };
}

/**
 * The offered machines a new task can run on. A thread without a project never moves to a box;
 * one with a project never moves to a host that runs no agents.
 */
export function useNewTaskRunTargets<Environment extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<Environment>,
  isScratchDraft: boolean,
): ReadonlyArray<Environment> {
  const serverConfigs = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  return useMemo(
    () =>
      isScratchDraft
        ? environments.filter((environment) => savedConnectionsById[environment.environmentId])
        : newTaskRunTargets(environments, serverConfigs),
    [environments, isScratchDraft, savedConnectionsById, serverConfigs],
  );
}

/**
 * A pick that lands on another chat's box (a route, a resumed draft, or a box list that arrived
 * late) leaves it as the web composer does: for a fresh box on its host, else for the same
 * repository on a machine that runs agents, which this selects.
 */
export function useNewTaskCloud(input: {
  readonly pick: NewTaskEnvironmentPick;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly selectedProjectKey: string | null;
  readonly setProject: (project: EnvironmentProject) => void;
}): NewTaskCloud {
  const { pick, projects, selectedProjectKey, setProject } = input;
  const { blockedBox, boxes, placement } = pick;
  const serverConfigs = useServerConfigs();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const blockedBoxProject = useMemo(() => {
    if (blockedBox === null) return null;
    const onBox = projects.filter((project) => project.environmentId === blockedBox);
    return (
      onBox.find(
        (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
      ) ??
      onBox[0] ??
      null
    );
  }, [blockedBox, projects, selectedProjectKey]);
  const boxStart = useMemo<NewThreadStart | null>(
    () =>
      blockedBoxProject === null
        ? null
        : resolveNewThreadStart({
            project: blockedBoxProject,
            serverConfigs,
            boxes,
            environments: newTaskEnvironments({
              projects,
              selectedProject: blockedBoxProject,
              savedConnectionsById,
              serverConfigs,
            }),
          }),
    [blockedBoxProject, boxes, projects, savedConnectionsById, serverConfigs],
  );
  useEffect(() => {
    if (boxStart?.kind !== "environment" || blockedBoxProject === null) return;
    const match = resolveEnvironmentProjectMatch(
      projects.filter((project) => project.environmentId === boxStart.environmentId),
      blockedBoxProject,
    );
    if (match) setProject(match);
  }, [blockedBoxProject, boxStart, projects, setProject]);
  return useMemo(() => ({ boxes, placement, boxStart }), [boxes, placement, boxStart]);
}

/**
 * Replaces the draft with a fresh cloud machine when the flow leaves another chat's box for one.
 * Shared content stays on the draft path, which owns its reservation.
 */
export function useCloudMachineInsteadOfBox(
  boxStart: NewThreadStart | null,
  input: { readonly incomingShareId: string | undefined; readonly branch: string | null },
): void {
  const navigation = useNavigation();
  const start = boxStart?.kind === "cloud-machine" && !input.incomingShareId ? boxStart : null;
  const { branch } = input;
  useEffect(() => {
    if (!start) return;
    navigation.dispatch(
      StackActions.replace("NewTaskCloudMachine", {
        environmentId: String(start.managerId),
        repository: start.repository,
        ...(branch ? { branch } : {}),
      }),
    );
  }, [start, branch, navigation]);
}
