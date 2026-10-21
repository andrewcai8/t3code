import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  defaultNewThreadProjectRef,
  resolveNewThreadModelSelectionOverride,
  resolveThreadActionProjectRef,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

  it("never picks Home's folder as the default project", () => {
    const home = { environmentId: ENVIRONMENT_ID, id: PROJECT_ID, workspaceRoot: "/data/home" };
    const app = {
      environmentId: ENVIRONMENT_ID,
      id: FALLBACK_PROJECT_ID,
      workspaceRoot: "/code/app",
    };
    const options = { primaryEnvironmentId: ENVIRONMENT_ID, homeWorkspaceRoot: "/data/home" };
    expect(defaultNewThreadProjectRef([home, app], options)).toEqual(
      scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    );
    expect(defaultNewThreadProjectRef([home], options)).toBeNull();
  });

  it("never starts a new thread in Home's folder from Home's draft before its shell loads", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          threadId: "home:current",
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID));
  });

  it("never starts a new thread in Home's folder from Home", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: { id: "home:current", environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
        activeDraftThread: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID));
  });
});
