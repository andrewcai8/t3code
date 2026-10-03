import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "../sidebarProjectGrouping";
import type { Project } from "../types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const defaultGroupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("the project picker with cloud boxes", () => {
  it("targets the host's copy of a repository and offers none that only cloud boxes hold", () => {
    const boxEnvironmentId = EnvironmentId.make("env-box");
    const host = makeProject({
      id: ProjectId.make("host-megpt"),
      title: "megpt-mono",
      workspaceRoot: "/data/repos/megpt-mono",
      repositoryIdentity,
    });
    const box = makeProject({
      id: ProjectId.make("box-workspace"),
      environmentId: boxEnvironmentId,
      title: "workspace",
      workspaceRoot: "/tmp/t3-provision/lease/workspace",
      repositoryIdentity,
    });
    const boxOnly = makeProject({
      id: ProjectId.make("box-only"),
      environmentId: boxEnvironmentId,
      title: "box-only",
      workspaceRoot: "/tmp/t3-provision/lease/other",
    });
    const groups = buildSidebarProjectSnapshots({
      projects: [box, host, boxOnly],
      settings: defaultGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });

    const entries = buildSidebarProjectPickerEntries({
      groups,
      // Viewing the box's own chat, or no chat with the box's copy first in sidebar order.
      preferredProjectRef: { environmentId: boxEnvironmentId, projectId: box.id },
      // A cloud box is not a user environment, so it has no state.
      environmentState: (environmentId) => (environmentId === boxEnvironmentId ? null : {}),
    });

    expect(
      entries.map((entry) => [entry.group.displayName, entry.targetProject.workspaceRoot]),
    ).toEqual([["megpt-mono", "/data/repos/megpt-mono"]]);
  });
});
