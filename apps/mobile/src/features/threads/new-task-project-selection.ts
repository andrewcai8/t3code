import {
  newChatRunTargets,
  offeredProvisionProviders,
  runsLocalAgents,
} from "@t3tools/client-runtime/cloud";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cloneRepository, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

type DraftProjectSelectionResolution =
  | { readonly kind: "preserve" }
  | { readonly kind: "select"; readonly project: EnvironmentProject }
  | { readonly kind: "pick" };

export function getProjectScopeSelectionTarget(
  scope: HomeProjectScope,
  preferredEnvironmentId: EnvironmentId | null,
): EnvironmentProject {
  return (
    scope.projects.find((project) => project.environmentId === preferredEnvironmentId) ??
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

interface NewTaskEnvironmentsInput {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "localAgentRuns">>;
  /** Cloud boxes the hosts report. A new task always gets a fresh box, never one of these. */
  readonly boxes: ReadonlySet<EnvironmentId>;
}

function newTaskRunTargets<Environment extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<Environment>,
  input: NewTaskEnvironmentsInput,
): ReadonlyArray<Environment> {
  return newChatRunTargets({
    environments,
    environmentState: (environmentId) => ({ serverConfig: input.serverConfigs.get(environmentId) }),
    environmentId: null,
    managerConfig: null,
    boxes: input.boxes,
  }).environments;
}

/** Where a new task starts before the user picks: the first machine a new task can run on. */
export function defaultNewTaskEnvironmentId(input: NewTaskEnvironmentsInput): EnvironmentId | null {
  return (newTaskRunTargets(input.projects, input)[0] ?? input.projects[0])?.environmentId ?? null;
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
  | { readonly kind: "cloud-machine"; readonly repository: string };

/**
 * How a new thread in `project` starts. A host that runs no agents but can provision refuses a
 * draft on itself, so the thread starts by cloning the project's repository onto a new cloud
 * machine. Everywhere else, and for a project with no repository to clone, it opens a draft on
 * the project as before.
 */
export function resolveNewThreadStart(
  project: Pick<EnvironmentProject, "repositoryIdentity">,
  hostConfig:
    | Pick<ServerConfig, "localAgentRuns" | "environmentControl" | "provisionProviders">
    | null
    | undefined,
): NewThreadStart {
  const repository = cloneRepository(project.repositoryIdentity);
  return repository !== undefined &&
    !runsLocalAgents(hostConfig) &&
    offeredProvisionProviders(hostConfig).length > 0
    ? { kind: "cloud-machine", repository }
    : { kind: "draft" };
}
