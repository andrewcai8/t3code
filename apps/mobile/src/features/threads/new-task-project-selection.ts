import { newChatRunTargets } from "@t3tools/client-runtime/cloud";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cloneRepository, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

/** The project a picked scope opens: the one on the preferred machine, else one on no other chat's box. */
export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
  boxes: ReadonlyMap<EnvironmentId, EnvironmentId>,
): EnvironmentProject {
  return (
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
    (boxes.has(scope.representative.environmentId)
      ? scope.projects.find((project) => !boxes.has(project.environmentId))
      : undefined) ??
    scope.representative
  );
}

export function filterProjectScopes(
  scopes: ReadonlyArray<HomeProjectScope>,
  searchText: string,
): ReadonlyArray<HomeProjectScope> {
  const query = searchText.trim().toLowerCase();
  if (!query) return scopes;
  return scopes.filter(
    (scope) =>
      scope.title.toLowerCase().includes(query) ||
      scope.projects.some(
        (project) =>
          project.title.toLowerCase().includes(query) ||
          project.workspaceRoot.toLowerCase().includes(query),
      ),
  );
}

function getOnlySelectableProject(
  projectScopes: ReadonlyArray<HomeProjectScope>,
): EnvironmentProject | null {
  const onlyScope = projectScopes.length === 1 ? projectScopes[0] : null;
  return onlyScope?.representative ?? null;
}

/**
 * Picks the project on a target environment that corresponds to the project
 * currently selected in the new-task flow, so switching computers follows the
 * same repo. Repository identity is preferred; projects without one (e.g. not
 * yet indexed) fall back to workspace basename, then title. When nothing
 * matches, the first project on the target stands in — the same fallback the
 * render path applies when no key is selected — so the draft always has a
 * concrete key to carry over to.
 */
export function resolveEnvironmentProjectMatch(
  projectsOnTarget: ReadonlyArray<EnvironmentProject>,
  selectedProject: EnvironmentProject | null,
): EnvironmentProject | null {
  const repositoryKey = selectedProject?.repositoryIdentity?.canonicalKey ?? null;
  // `|| null` (not `??`): a pending-task placeholder project can have an empty
  // workspaceRoot, and an "" basename would match nothing meaningful.
  const workspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  // The weaker signals only apply where identity is unknown on at least one
  // side; two known, different repositories never match on a shared basename
  // or title (mirrors the environment list filter in the new-task flow).
  const isKnownMismatch = (project: EnvironmentProject) => {
    const projectKey = project.repositoryIdentity?.canonicalKey ?? null;
    return repositoryKey !== null && projectKey !== null && projectKey !== repositoryKey;
  };
  return (
    (repositoryKey !== null
      ? projectsOnTarget.find(
          (project) => (project.repositoryIdentity?.canonicalKey ?? null) === repositoryKey,
        )
      : undefined) ??
    (workspaceBasename !== null
      ? projectsOnTarget.find(
          (project) =>
            !isKnownMismatch(project) &&
            project.workspaceRoot.split("/").at(-1) === workspaceBasename,
        )
      : undefined) ??
    (selectedProject !== null
      ? projectsOnTarget.find(
          (project) => !isKnownMismatch(project) && project.title === selectedProject.title,
        )
      : undefined) ??
    projectsOnTarget[0] ??
    null
  );
}

export function resolveDraftProjectSelection(
  selectedProjectKey: string | null,
  projects: ReadonlyArray<EnvironmentProject>,
  projectScopes: ReadonlyArray<HomeProjectScope>,
): DraftProjectSelectionResolution {
  const hasExplicitProjectSelection =
    selectedProjectKey !== null &&
    projects.some(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    );
  if (hasExplicitProjectSelection) {
    return { kind: "preserve" };
  }

  const onlyProject = getOnlySelectableProject(projectScopes);
  return onlyProject ? { kind: "select", project: onlyProject } : { kind: "pick" };
}

export interface NewTaskEnvironment {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}

type NewTaskServerConfig = Pick<
  ServerConfig,
  "localAgentRuns" | "environmentControl" | "provisionProviders"
>;

interface NewTaskEnvironmentsInput {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, NewTaskServerConfig>;
  /**
   * Boxes other chats run on, each mapped to the host that provisioned it. A new task always
   * gets a fresh box, never one of these.
   */
  readonly boxes: ReadonlyMap<EnvironmentId, EnvironmentId>;
}

function newTaskRunTargets<Environment extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<Environment>,
  input: Pick<NewTaskEnvironmentsInput, "serverConfigs" | "boxes">,
): ReadonlyArray<Environment> {
  return newChatRunTargets({
    environments,
    environmentState: (environmentId) => ({ serverConfig: input.serverConfigs.get(environmentId) }),
    environmentId: null,
    managerConfig: null,
    boxes: input.boxes,
  }).environments;
}

/**
 * Where a new task starts before the user picks: the first machine a new task can run on, else
 * the first that is no other chat's box, so a host that runs no agents starts a fresh box.
 */
export function defaultNewTaskEnvironmentId(input: NewTaskEnvironmentsInput): EnvironmentId | null {
  return (
    (
      newTaskRunTargets(input.projects, input)[0] ??
      input.projects.find((project) => !input.boxes.has(project.environmentId))
    )?.environmentId ?? null
  );
}

/**
 * The machine the new-task flow points at: the one picked, unless it is gone or another chat's
 * box, and then the default. A queued task being edited stays on its own machine, box or not.
 */
export function resolveNewTaskEnvironmentId(
  input: NewTaskEnvironmentsInput & {
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

/**
 * The machines a new task can move to. Only machines that host the selected repository, so
 * switching computers moves the same repo across machines instead of jumping to whatever
 * unrelated project happens to be first on the other machine. Repository identity is the
 * primary signal; projects that haven't reported one yet (still indexing) fall back to
 * workspace basename / title so a valid host isn't hidden.
 */
export function newTaskEnvironments(
  input: NewTaskEnvironmentsInput & {
    readonly selectedProject: EnvironmentProject | null;
    readonly savedConnectionsById: Readonly<
      Record<EnvironmentId, { readonly environmentLabel: string } | undefined>
    >;
  },
): ReadonlyArray<NewTaskEnvironment> {
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
  return newTaskRunTargets(candidates, input);
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
  readonly boxes: ReadonlyMap<EnvironmentId, EnvironmentId>;
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
