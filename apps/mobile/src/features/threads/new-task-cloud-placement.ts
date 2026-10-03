import {
  newChatProject,
  newChatRunTargets,
  offeredProvisionProviders,
  runsLocalAgents,
  type NewChatEnvironmentState,
} from "@t3tools/client-runtime/cloud";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cloneRepository, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import type { HomeProjectScope } from "../home/homeThreadList";
import { getProjectScopeSelectionTarget } from "./new-task-project-selection";

/** What `newChatProject` reads: each user environment's state. A cloud box has none. */
export function newChatPlacement(
  environmentStates: ReadonlyMap<EnvironmentId, NewChatEnvironmentState>,
) {
  return {
    environmentState: (environmentId: EnvironmentId) => environmentStates.get(environmentId),
  };
}

export type NewChatPlacement = ReturnType<typeof newChatPlacement>;

/**
 * The project a picked scope opens: the one on the preferred machine, else the representative,
 * moved off any box or gone machine. Null when only boxes hold the scope.
 */
export function newChatScopeTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  placement: NewChatPlacement,
): EnvironmentProject | null {
  const requested = getProjectScopeSelectionTarget(scope, preferredEnvironmentId);
  return newChatProject({
    requested: scopeProjectRef(requested.environmentId, requested.id),
    projects: scope.projects,
    logicalProjectKey: () => scope.key,
    ...placement,
  });
}

/**
 * The hosts whose box lists the client reads: connected ones that can provision. A host still
 * connecting would never answer.
 */
export function provisioningHostIds(
  serverConfigs: ReadonlyMap<EnvironmentId, NewTaskServerConfig>,
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: string;
  }>,
): ReadonlyArray<EnvironmentId> {
  return environments.flatMap(({ environmentId, connectionState }) =>
    connectionState === "connected" &&
    offeredProvisionProviders(serverConfigs.get(environmentId)).length > 0
      ? [environmentId]
      : [],
  );
}

export interface NewTaskEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

type NewTaskServerConfig = Pick<
  ServerConfig,
  "localAgentRuns" | "environmentControl" | "provisionProviders"
>;

/**
 * Boxes other chats run on, each mapped to the host that provisioned it. A new task always gets a
 * fresh box, never one of these.
 */
type OtherChatBoxes = ReadonlyMap<EnvironmentId, EnvironmentId>;

/**
 * Where a new task starts before the user picks: a machine that runs agents, else any, so a host
 * that runs no agents starts a fresh box. Never a box, claimed or not, nor a gone machine.
 */
export function defaultNewTaskEnvironmentId(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, NewTaskServerConfig>;
  readonly placement: NewChatPlacement;
}): EnvironmentId | null {
  const place = (projects: ReadonlyArray<EnvironmentProject>) =>
    newChatProject({ requested: null, projects, logicalProjectKey: () => "", ...input.placement });
  const runsAgents = input.projects.filter((project) =>
    runsLocalAgents(input.serverConfigs.get(project.environmentId)),
  );
  return (place(runsAgents) ?? place(input.projects))?.environmentId ?? null;
}

/**
 * The machine the new-task flow points at: the one picked, unless it is gone or another chat's
 * box, and then the default. A queued task being edited stays on its own machine, box or not.
 */
export function resolveNewTaskEnvironmentId(
  input: Parameters<typeof defaultNewTaskEnvironmentId>[0] & {
    readonly boxes: OtherChatBoxes;
    readonly picked: EnvironmentId | null;
    readonly pinned: boolean;
  },
): EnvironmentId | null {
  const { picked } = input;
  return picked !== null &&
    input.projects.some((project) => project.environmentId === picked) &&
    (input.pinned || !input.boxes.has(picked))
    ? picked
    : defaultNewTaskEnvironmentId(input);
}

/** The machines among `environments` a new task can run on: never a host that runs no agents. */
export function newTaskRunTargets<Environment extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<Environment>,
  serverConfigs: ReadonlyMap<EnvironmentId, NewTaskServerConfig>,
): ReadonlyArray<Environment> {
  return newChatRunTargets({
    environments,
    environmentState: (environmentId) => ({ serverConfig: serverConfigs.get(environmentId) }),
    environmentId: null,
    managerConfig: null,
  }).environments;
}

/**
 * The machines a new task in `selectedProject` can move to: those hosting the same repository,
 * matched as the new-task flow matches its selected project, that run agents.
 */
export function newTaskEnvironments(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, NewTaskServerConfig>;
  readonly selectedProject: EnvironmentProject | null;
  /** The user environments; a cloud box is not one, so it is never offered. */
  readonly savedConnectionsById: Readonly<
    Record<EnvironmentId, { readonly environmentLabel: string } | undefined>
  >;
}): ReadonlyArray<NewTaskEnvironment> {
  const selectedRepositoryKey = input.selectedProject?.repositoryIdentity?.canonicalKey ?? null;
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would reject every real host below.
  const selectedWorkspaceBasename = input.selectedProject?.workspaceRoot.split("/").at(-1) || null;
  const selectedProjectTitle = input.selectedProject?.title ?? null;
  const hostsSelectedRepository = (project: EnvironmentProject) => {
    if (selectedRepositoryKey === null && selectedWorkspaceBasename === null) {
      return true;
    }
    const projectKey = project.repositoryIdentity?.canonicalKey ?? null;
    if (selectedRepositoryKey !== null && projectKey !== null) {
      return projectKey === selectedRepositoryKey;
    }
    return (
      project.workspaceRoot.split("/").at(-1) === selectedWorkspaceBasename ||
      (selectedProjectTitle !== null && project.title === selectedProjectTitle)
    );
  };
  const seen = new Set<EnvironmentId>();
  const candidates: NewTaskEnvironment[] = [];
  for (const project of input.projects) {
    const environment = input.savedConnectionsById[project.environmentId];
    if (!environment || seen.has(project.environmentId) || !hostsSelectedRepository(project)) {
      continue;
    }
    seen.add(project.environmentId);
    candidates.push({
      environmentId: project.environmentId,
      environmentLabel: environment.environmentLabel,
    });
  }
  return newTaskRunTargets(candidates, input.serverConfigs);
}

export type NewThreadStart =
  | { readonly kind: "draft" }
  | {
      readonly kind: "cloud-machine";
      readonly managerId: EnvironmentId;
      readonly repository: string;
    }
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId };

/**
 * How a new thread in `project` starts, by the same rules as the web composer. A host that runs
 * no agents but can provision refuses a draft on itself, and a new thread never joins another
 * chat's box, so either starts a fresh cloud machine for the project's repository on that host.
 * With no cloud machine to start, it moves to the first of `environments` that can take it, else
 * opens a draft on the project as before.
 */
export function resolveNewThreadStart(input: {
  readonly project: Pick<EnvironmentProject, "environmentId" | "repositoryIdentity">;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, NewTaskServerConfig>;
  readonly boxes: OtherChatBoxes;
  /** Machines holding the same repository, in the order to prefer them. */
  readonly environments?: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
}): NewThreadStart {
  const { environmentId } = input.project;
  const managerId = input.boxes.get(environmentId) ?? environmentId;
  const targets = newChatRunTargets({
    environments: input.environments ?? [],
    environmentState: (id) => ({ serverConfig: input.serverConfigs.get(id) }),
    environmentId,
    managerConfig: input.serverConfigs.get(managerId),
    boxes: input.boxes,
  });
  const repository = cloneRepository(input.project.repositoryIdentity);
  if (targets.redirect?.kind === "cloud" && repository !== undefined) {
    return { kind: "cloud-machine", managerId, repository };
  }
  const moveTo =
    targets.redirect?.kind === "environment"
      ? targets.redirect.environment
      : targets.redirect?.kind === "cloud"
        ? targets.environments[0]
        : undefined;
  return moveTo ? { kind: "environment", environmentId: moveTo.environmentId } : { kind: "draft" };
}
