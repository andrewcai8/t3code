import { EnvironmentId, ProjectId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { HomeProjectScope } from "../home/homeThreadList";
import {
  defaultNewTaskEnvironmentId,
  filterProjectScopes,
  getProjectScopeSelectionTarget,
  newChatPlacement,
  newTaskEnvironments,
  provisioningHostIds,
  resolveDraftProjectSelection,
  resolveEnvironmentProjectMatch,
  resolveNewTaskEnvironmentId,
  resolveNewThreadStart,
} from "./new-task-project-selection";

type HostConfig = Pick<
  ServerConfig,
  "localAgentRuns" | "environmentControl" | "provisionProviders"
>;

function makeProject(
  id: string,
  environmentId = "environment",
  options: {
    readonly title?: string;
    readonly workspaceRoot?: string;
    readonly repositoryKey?: string;
  } = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: options.title ?? id,
    workspaceRoot: options.workspaceRoot ?? `/work/${id}`,
    repositoryIdentity: options.repositoryKey
      ? {
          canonicalKey: options.repositoryKey,
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: `https://${options.repositoryKey}.git`,
          },
        }
      : null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function makeScope(projects: ReadonlyArray<EnvironmentProject>): HomeProjectScope {
  return {
    key: "github.com/t3tools/t3code",
    title: "T3 Code",
    representative: projects[0]!,
    projects,
    projectRefs: projects.map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
    })),
  };
}

/** The user environments' states, one of them a gone machine. A cloud box is never one. */
function userEnvironments(...environmentIds: ReadonlyArray<string>) {
  return new Map([
    ...environmentIds.map((environmentId) => [EnvironmentId.make(environmentId), {}] as const),
    [EnvironmentId.make("gone"), { connection: { blockedReason: "workspace-missing" as const } }],
  ]);
}

describe("getProjectScopeSelectionTarget", () => {
  const target = (projects: ReadonlyArray<EnvironmentProject>, preferred: string) =>
    getProjectScopeSelectionTarget(
      makeScope(projects),
      EnvironmentId.make(preferred),
      newChatPlacement(userEnvironments("mac", "server", "host")),
    )?.id;

  it("keeps the current environment when it hosts the selected logical project", () => {
    const projects = [makeProject("t3code-mac", "mac"), makeProject("t3code-server", "server")];
    expect(target(projects, "server")).toBe("t3code-server");
  });

  it("falls back to the representative when the current environment does not host the project", () => {
    const projects = [makeProject("t3code-mac", "mac"), makeProject("t3code-server", "server")];
    expect(target(projects, "other")).toBe("t3code-mac");
  });

  it("opens the host copy when the representative or the preferred machine is a box", () => {
    const projects = [makeProject("t3code-box", "box"), makeProject("t3code-host", "host")];
    expect(target(projects, "other")).toBe("t3code-host");
    expect(target(projects, "box")).toBe("t3code-host");
  });

  it("opens the host copy when the representative's machine is gone", () => {
    const projects = [makeProject("t3code-gone", "gone"), makeProject("t3code-host", "host")];
    expect(target(projects, "other")).toBe("t3code-host");
  });

  it("offers nothing when only boxes hold the project", () => {
    const projects = [makeProject("t3code-box", "box"), makeProject("t3code-gone", "gone")];
    expect(target(projects, "box")).toBe(undefined);
  });
});

describe("resolveEnvironmentProjectMatch", () => {
  it("follows the same repository onto the target machine", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [
      makeProject("other", "server", { repositoryKey: "github.com/t3tools/other" }),
      makeProject("t3code-clone", "server", { repositoryKey: "github.com/t3tools/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[1]);
  });

  it("falls back to workspace basename, then title, for unindexed projects", () => {
    const selected = makeProject("t3code", "mac", { workspaceRoot: "/Users/me/t3code" });
    const byBasename = [
      makeProject("other", "server"),
      makeProject("srv", "server", { workspaceRoot: "/home/me/t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byBasename, selected)).toBe(byBasename[1]);

    const byTitle = [
      makeProject("other", "server"),
      makeProject("srv", "server", { title: "t3code" }),
    ];
    expect(resolveEnvironmentProjectMatch(byTitle, selected)).toBe(byTitle[1]);
  });

  it("does not treat a known different repository as a basename or title match", () => {
    const selected = makeProject("t3code", "mac", {
      repositoryKey: "github.com/t3tools/t3code",
      workspaceRoot: "/Users/me/t3code",
    });
    const fork = makeProject("fork", "server", {
      repositoryKey: "github.com/someone/t3code",
      title: "t3code",
      workspaceRoot: "/home/me/t3code",
    });
    const unindexed = makeProject("unindexed", "server", { workspaceRoot: "/srv/t3code" });
    expect(resolveEnvironmentProjectMatch([fork, unindexed], selected)).toBe(unindexed);
    // Without any weaker match the fork is still the first-project fallback.
    expect(resolveEnvironmentProjectMatch([fork], selected)).toBe(fork);
  });

  it("falls back to the first project on the target so the draft has a key to carry over to", () => {
    const selected = makeProject("t3code", "mac", { repositoryKey: "github.com/t3tools/t3code" });
    const target = [makeProject("unrelated", "server"), makeProject("also-unrelated", "server")];
    expect(resolveEnvironmentProjectMatch(target, selected)).toBe(target[0]);
    expect(resolveEnvironmentProjectMatch([], selected)).toBeNull();
  });
});

describe("resolveDraftProjectSelection", () => {
  it("preserves an explicit project selection", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:t3code", [project], [makeScope([project])]),
    ).toEqual({ kind: "preserve" });
  });

  it("selects the only physical project when no project was explicitly selected", () => {
    const project = makeProject("t3code");
    expect(resolveDraftProjectSelection(null, [project], [makeScope([project])])).toEqual({
      kind: "select",
      project,
    });
  });

  it("selects one logical project even when it has multiple physical workspaces", () => {
    const projects = [makeProject("t3code"), makeProject("t3code-2"), makeProject("t3code-3")];
    expect(resolveDraftProjectSelection(null, projects, [makeScope(projects)])).toEqual({
      kind: "select",
      project: projects[0],
    });
  });

  it("does not preserve a project key that is missing from the catalog", () => {
    const project = makeProject("t3code");
    expect(
      resolveDraftProjectSelection("environment:removed", [project], [makeScope([project])]),
    ).toEqual({
      kind: "select",
      project,
    });
  });
});

describe("filterProjectScopes", () => {
  const mac = makeProject("code", "mac", { title: "Desktop checkout" });
  const server = makeProject("remote-code", "server", { workspaceRoot: "/srv/remote-workspace" });
  const code = makeScope([mac, server]);
  const docs = { ...makeScope([makeProject("docs")]), key: "docs", title: "Documentation" };
  const scopes = [code, docs];

  it("keeps all projects for an empty or whitespace-only query", () => {
    expect(filterProjectScopes(scopes, "")).toBe(scopes);
    expect(filterProjectScopes(scopes, "  ")).toBe(scopes);
  });

  it("matches logical names and workspace names or paths without case sensitivity", () => {
    expect(filterProjectScopes(scopes, "  T3 CODE ")).toEqual([code]);
    expect(filterProjectScopes(scopes, "DESKTOP")).toEqual([code]);
    expect(filterProjectScopes(scopes, "REMOTE-WORKSPACE")).toEqual([code]);
    expect(filterProjectScopes(scopes, "documentation")).toEqual([docs]);
    expect(filterProjectScopes(scopes, "missing-project")).toEqual([]);
  });

  it("preserves the whole logical project and preferred environment when a workspace matches", () => {
    const matches = filterProjectScopes(scopes, "REMOTE-WORKSPACE");
    expect(matches[0]).toBe(code);
    expect(
      getProjectScopeSelectionTarget(
        matches[0]!,
        EnvironmentId.make("mac"),
        newChatPlacement(userEnvironments("mac", "server")),
      ),
    ).toBe(mac);
    expect(code.projects).toEqual([mac, server]);
  });
});

describe("resolveNewThreadStart", () => {
  const onHost = makeProject("t3code", "host", { repositoryKey: "github.com/andrewcai8/t3code" });
  const project = {
    ...onHost,
    repositoryIdentity: { ...onHost.repositoryIdentity!, owner: "andrewcai8", name: "t3code" },
  };
  const cloudOnlyHost = {
    localAgentRuns: false,
    environmentControl: true,
    provisionProviders: ["e2b", "namespace"] as const,
  };
  const start = (subject: EnvironmentProject, hostConfig: HostConfig | undefined) =>
    resolveNewThreadStart({
      project: subject,
      serverConfigs: new Map(hostConfig ? [[EnvironmentId.make("host"), hostConfig]] : []),
      boxes: new Map(),
    });

  it("starts a cloud machine from a host that runs no agents but can provision", () => {
    expect(start(project, cloudOnlyHost)).toEqual({
      kind: "cloud-machine",
      managerId: EnvironmentId.make("host"),
      repository: "andrewcai8/t3code",
    });
  });

  it("opens a draft on a host that runs agents, or predates the switch", () => {
    expect(start(project, { ...cloudOnlyHost, localAgentRuns: true })).toEqual({
      kind: "draft",
    });
    expect(start(project, { environmentControl: true })).toEqual({ kind: "draft" });
    expect(start(project, undefined)).toEqual({ kind: "draft" });
  });

  it("opens a draft when the host cannot provision or there is nothing to clone", () => {
    expect(start(project, { ...cloudOnlyHost, provisionProviders: [] })).toEqual({
      kind: "draft",
    });
    expect(start(makeProject("scratch", "host"), cloudOnlyHost)).toEqual({
      kind: "draft",
    });
  });
});

describe("new task environments", () => {
  const repositoryKey = "github.com/andrewcai8/t3code";
  const host = EnvironmentId.make("host");
  const box = EnvironmentId.make("box");
  const namespaceBox = EnvironmentId.make("namespace-box");
  const laptop = EnvironmentId.make("laptop");
  const server = EnvironmentId.make("server");
  const onRepo = (id: string, environmentId: string) => {
    const project = makeProject(id, environmentId, { repositoryKey });
    return {
      ...project,
      repositoryIdentity: { ...project.repositoryIdentity!, owner: "andrewcai8", name: "t3code" },
    };
  };
  // Ordered as a sort by recent activity would put them: the boxes were touched last.
  const onBox = onRepo("on-box", "box");
  const onHost = onRepo("on-host", "host");
  const onNamespaceBox = onRepo("on-namespace-box", "namespace-box");
  const onLaptop = onRepo("on-laptop", "laptop");
  const onServer = onRepo("on-server", "server");
  const everywhere = [onBox, onHost, onNamespaceBox, onLaptop, onServer];
  const hostOnly = [onBox, onHost, onNamespaceBox];
  const savedConnectionsById = {
    [host]: { environmentLabel: "andrew.megpt.app" },
    [laptop]: { environmentLabel: "Laptop" },
    [server]: { environmentLabel: "Build server" },
  };
  const cloudOnlyHost = {
    localAgentRuns: false,
    environmentControl: true,
    provisionProviders: ["e2b", "namespace"] as const,
  };
  const serverConfigs = new Map<EnvironmentId, HostConfig>([
    [host, cloudOnlyHost],
    [laptop, { localAgentRuns: true }],
  ]);
  // Two boxes other chats run on, and one this phone just started for the task at hand.
  const ownBox = EnvironmentId.make("own-box");
  const boxes = new Map([
    [box, host],
    [namespaceBox, host],
  ]);
  const placement = newChatPlacement(userEnvironments(host, laptop, server));

  it("offers servers that run agents, never a running box or a host that runs none", () => {
    expect(
      newTaskEnvironments({
        projects: everywhere,
        selectedProject: onBox,
        savedConnectionsById,
        serverConfigs,
      }),
    ).toEqual([
      { environmentId: laptop, environmentLabel: "Laptop" },
      { environmentId: server, environmentLabel: "Build server" },
    ]);
  });

  it("starts on the first server that runs agents rather than a box", () => {
    expect(defaultNewTaskEnvironmentId({ projects: everywhere, serverConfigs, placement })).toBe(
      laptop,
    );
  });

  it("never starts on a box, even its own, or a gone machine", () => {
    const projects = [onRepo("on-own-box", "own-box"), onRepo("on-gone", "gone"), onHost, onLaptop];
    expect(defaultNewTaskEnvironmentId({ projects, serverConfigs, placement })).toBe(laptop);
    expect(
      defaultNewTaskEnvironmentId({ projects: projects.slice(0, 3), serverConfigs, placement }),
    ).toBe(host);
  });

  it("starts on the host, not a box, when only the host and boxes hold the project", () => {
    expect(defaultNewTaskEnvironmentId({ projects: hostOnly, serverConfigs, placement })).toBe(
      host,
    );
    // From there the host starts a fresh box instead of a draft on itself.
    expect(resolveNewThreadStart({ project: onHost, serverConfigs, boxes })).toEqual({
      kind: "cloud-machine",
      managerId: host,
      repository: "andrewcai8/t3code",
    });
  });

  it("ignores a pick of another chat's box unless a queued task being edited sits there", () => {
    const picked = (pinned: boolean) =>
      resolveNewTaskEnvironmentId({
        picked: box,
        pinned,
        projects: hostOnly,
        serverConfigs,
        boxes,
        placement,
      });
    expect(picked(false)).toBe(host);
    expect(picked(true)).toBe(box);
  });

  it("keeps a draft on the box it just started", () => {
    const onOwnBox = onRepo("on-own-box", "own-box");
    expect(
      resolveNewTaskEnvironmentId({
        picked: ownBox,
        pinned: false,
        projects: [...hostOnly, onOwnBox],
        serverConfigs,
        boxes,
        placement,
      }),
    ).toBe(ownBox);
    expect(resolveNewThreadStart({ project: onOwnBox, serverConfigs, boxes })).toEqual({
      kind: "draft",
    });
  });

  describe("a draft on another chat's box", () => {
    const leave = (input: {
      readonly hostConfig: HostConfig;
      readonly environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
    }) =>
      resolveNewThreadStart({
        project: onBox,
        serverConfigs: new Map<EnvironmentId, HostConfig>([
          [host, input.hostConfig],
          [laptop, { localAgentRuns: true }],
        ]),
        boxes,
        environments: input.environments,
      });

    it("starts a fresh box on the box's host", () => {
      expect(
        leave({ hostConfig: cloudOnlyHost, environments: [{ environmentId: laptop }] }),
      ).toEqual({ kind: "cloud-machine", managerId: host, repository: "andrewcai8/t3code" });
    });

    it("moves to a server that runs agents when the host starts no boxes", () => {
      expect(
        leave({
          hostConfig: { localAgentRuns: false },
          environments: [{ environmentId: laptop }],
        }),
      ).toEqual({ kind: "environment", environmentId: laptop });
    });

    it("stays when there is nowhere else to go", () => {
      expect(leave({ hostConfig: { localAgentRuns: false }, environments: [] })).toEqual({
        kind: "draft",
      });
    });
  });
});

describe("provisioningHostIds", () => {
  it("reads only connected hosts that can provision, so a sleeping host holds nothing back", () => {
    const provisions = { environmentControl: true, provisionProviders: ["e2b"] as const };
    const serverConfigs = new Map<EnvironmentId, HostConfig>([
      [EnvironmentId.make("host"), provisions],
      [EnvironmentId.make("sleeping-host"), provisions],
      [EnvironmentId.make("laptop"), { localAgentRuns: true }],
    ]);
    expect(
      provisioningHostIds(serverConfigs, [
        { environmentId: EnvironmentId.make("host"), connectionState: "connected" },
        { environmentId: EnvironmentId.make("sleeping-host"), connectionState: "reconnecting" },
        { environmentId: EnvironmentId.make("laptop"), connectionState: "connected" },
      ]),
    ).toEqual([EnvironmentId.make("host")]);
  });
});
