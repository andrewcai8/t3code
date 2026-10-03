import { newChatProject } from "@t3tools/client-runtime/cloud";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveComposerProviderSelection } from "../components/ChatView.logic";
import {
  DraftId,
  deriveEffectiveComposerModelState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { deriveProviderInstanceEntries } from "../providerInstances";
import {
  buildCloudHandoff,
  cloudCloneSource,
  isDraftOnAnotherChatsBox,
  knownRunOnEnvironments,
  needsLoadBalancedPick,
} from "./cloudChat.logic";

const now = "2026-03-29T00:00:00.000Z";

const HOST = EnvironmentId.make("andrew-megpt-host");
const BOX = EnvironmentId.make("e2b-box");
const hostProject = {
  environmentId: HOST,
  id: ProjectId.make("megpt-mono-host"),
  key: "megpt-mono",
};
const boxProject = { environmentId: BOX, id: ProjectId.make("megpt-mono-box"), key: "megpt-mono" };
const projects = [boxProject, hostProject];
const runOnOptions = [
  { environmentId: HOST, projectId: hostProject.id, label: "andrew.megpt.app" },
  { environmentId: BOX, projectId: boxProject.id, label: "e2b.local" },
];

/**
 * The reported state: a new chat's draft for megpt-mono whose project is the copy on `e2b.local`,
 * a cloud box saved before boxes were marked, now marked by the migration.
 */
describe("a draft on the megpt-mono copy of a legacy e2b.local box", () => {
  const draft = {
    draftId: "c3bea36c",
    environmentId: BOX,
    ownBoxEnvironmentId: null,
    boxIds: new Set([BOX]),
  };

  it("is not the box's, so it moves to the host's copy of the project", () => {
    expect(isDraftOnAnotherChatsBox(draft)).toBe(true);
    const moveTo = newChatProject({
      requested: { environmentId: BOX, projectId: boxProject.id },
      projects,
      logicalProjectKey: (project) => project.key,
      environmentState: (environmentId) => (environmentId === HOST ? { serverConfig: null } : null),
    });
    expect(moveTo).toEqual(hostProject);
  });

  it("never offers the box in Run on", () => {
    // The user environments; the box is not one, and it is not the draft's own.
    const known = new Map([[HOST, {}]]);
    expect(knownRunOnEnvironments(runOnOptions, known).map(({ label }) => label)).toEqual([
      "andrew.megpt.app",
    ]);
  });
});

describe("a draft on the box its own cloud send started", () => {
  it("keeps the box, which Run on names", () => {
    expect(
      isDraftOnAnotherChatsBox({
        draftId: "c3bea36c",
        environmentId: BOX,
        ownBoxEnvironmentId: BOX,
        boxIds: new Set([BOX]),
      }),
    ).toBe(false);
    const known = new Map([
      [HOST, {}],
      [BOX, {}],
    ]);
    expect(knownRunOnEnvironments(runOnOptions, known).map(({ label }) => label)).toEqual([
      "andrew.megpt.app",
      "e2b.local",
    ]);
  });
});

describe("needsLoadBalancedPick", () => {
  const laptop = { environmentId: EnvironmentId.make("laptop") };
  const desktop = { environmentId: EnvironmentId.make("desktop") };
  const host = EnvironmentId.make("host");

  it("picks again when the earlier pick no longer takes new chats", () => {
    expect(
      needsLoadBalancedPick({
        automatic: true,
        pickedEnvironmentId: host,
        candidates: [laptop, desktop],
      }),
    ).toBe(true);
  });

  it("keeps a pick that still takes new chats and picks when there is none", () => {
    expect(
      needsLoadBalancedPick({
        automatic: true,
        pickedEnvironmentId: laptop.environmentId,
        candidates: [laptop, desktop],
      }),
    ).toBe(false);
    expect(
      needsLoadBalancedPick({ automatic: true, pickedEnvironmentId: null, candidates: [laptop] }),
    ).toBe(true);
  });

  it("never picks for a manually placed draft", () => {
    expect(
      needsLoadBalancedPick({ automatic: false, pickedEnvironmentId: host, candidates: [laptop] }),
    ).toBe(false);
  });
});

describe("cloudCloneSource", () => {
  const identity = {
    canonicalKey: "github.com/me/repo",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "git@github.com:me/repo.git",
    },
    owner: "me",
    name: "repo",
  };

  it("sends a branch only when the user picked one, and only with a repository", () => {
    expect([
      cloudCloneSource(identity, null),
      cloudCloneSource(identity, "feature"),
      cloudCloneSource(null, "feature"),
    ]).toEqual([{ repository: "me/repo" }, { repository: "me/repo", branch: "feature" }, {}]);
  });
});

describe("buildCloudHandoff", () => {
  const claudeAgent = ProviderDriverKind.make("claudeAgent");
  const models = (...slugs: ReadonlyArray<string>): ServerProvider["models"] =>
    slugs.map((slug, index) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: index === 0,
      capabilities: null,
    }));
  const claudeSnapshot = (instanceId: string, slugs: ServerProvider["models"]): ServerProvider => ({
    driver: claudeAgent,
    instanceId: ProviderInstanceId.make(instanceId),
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: now,
    models: slugs,
    slashCommands: [],
    skills: [],
  });
  const picked = createModelSelection(ProviderInstanceId.make("claude_work"), "claude-opus-5-5", [
    { id: "effort", value: "high" },
    { id: "contextWindow", value: "1m" },
  ]);

  /** What the box composer sends after the draft is handed off to it. */
  function sendOnBox() {
    const draftId = DraftId.make("draft-cloud-handoff");
    const store = useComposerDraftStore.getState();
    store.setModelSelection(draftId, picked, { explicit: true });
    const handoff = buildCloudHandoff({ agentDriver: claudeAgent, selection: picked });
    store.setModelSelection(draftId, handoff.modelSelection);

    const boxProviders = [
      claudeSnapshot("claudeAgent", models("claude-fable-5-1", "claude-opus-5-5")),
    ];
    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    const { selectedProviderEntry } = resolveComposerProviderSelection({
      entries: deriveProviderInstanceEntries(boxProviders),
      candidateInstanceIds: [draft?.activeProvider],
      lockedProvider: null,
      lockedInstanceId: null,
    });
    const selectedInstanceId = selectedProviderEntry?.instanceId ?? null;
    const state = deriveEffectiveComposerModelState({
      draft,
      providers: boxProviders,
      selectedProvider: selectedProviderEntry?.driverKind ?? claudeAgent,
      selectedInstanceId,
      threadModelSelection: null,
      projectModelSelection: null,
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    return {
      instanceId: selectedInstanceId,
      model: state.selectedModel,
      options: selectedInstanceId ? state.modelOptions?.[selectedInstanceId] : undefined,
    };
  }

  afterEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    ["codex", "codex_work", "codex"],
    ["cursor", "cursor_work", "cursor"],
    ["claudeAgent", "claude_work", "claudeAgent"],
  ])("moves a %s selection from %s to the box's %s instance", (driver, hostId, boxId) => {
    const selection = createModelSelection(ProviderInstanceId.make(hostId), "some-model", [
      { id: "effort", value: "high" },
    ]);
    expect(
      buildCloudHandoff({
        agentDriver: ProviderDriverKind.make(driver),
        selection,
      }).modelSelection,
    ).toEqual({
      instanceId: boxId,
      model: "some-model",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("keeps the model and options picked for a host account on the box's own instance", () => {
    expect(sendOnBox()).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "contextWindow", value: "1m" },
      ],
    });
  });
});
