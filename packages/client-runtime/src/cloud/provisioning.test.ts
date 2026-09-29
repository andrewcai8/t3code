import {
  EnvironmentId,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionResult,
  ProjectId,
  ProviderDriverKind,
  type ProvisionRequestId,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createProvisionRequestStore,
  PROVISION_IN_PROGRESS_MESSAGE,
  type ProvisionRequestStore,
} from "./provisionRequests.ts";
import { createProvisionedSandboxLeaseStore } from "./provisionedSandboxLeases.ts";
import {
  type CloudProvisionPorts,
  boxesOfOtherChats,
  claimFirstTurnBox,
  idleProvisionedBoxes,
  type NewChatEnvironmentState,
  newChatProject,
  newChatRunTargets,
  nextDraftEnvironment,
  offeredProvisionProviders,
  type ProvisionedBoxClaim,
  provisionCloudEnvironment,
} from "./provisioning.ts";
import type { ProvisionStorage } from "./storage.ts";

const draft = {
  draftId: "draft",
  managerEnvironmentId: EnvironmentId.make("manager"),
  input: {
    provider: "e2b" as const,
    providerInstanceId: "codex-account",
    agentDriver: ProviderDriverKind.make("codex"),
    repository: "example/repository",
  },
};
const preparedEnvironmentId = EnvironmentId.make("prepared");
const readyEnvironment = {
  environmentId: preparedEnvironmentId,
  leaseId: "lease",
  provider: "e2b" as const,
  sandboxId: "sandbox",
  projectDir: "/workspace",
  providerInstanceId: "codex-account",
  sourceRevision: null,
  t3Revision: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  control: {
    preparationRoot: "/prepared",
    brokerCredentialPath: "/prepared/credential",
    localT3Url: "http://localhost:3773",
    runtimeExecutable: "node",
    runtimeEntrypoint: "/prepared/t3/index.mjs",
  },
};

function memoryStorage(): ProvisionStorage {
  const records = new Map<string, string>();
  return {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => {
      records.set(key, value);
    },
    removeItem: (key) => {
      records.delete(key);
    },
  };
}

/**
 * Fake ports that answer like a healthy manager and record every call. Each `answer` entry
 * overrides one step; the request store and lease store are real, over in-memory storage.
 */
function harness(answers: {
  readonly provision?: (
    requestId: ProvisionRequestId,
    requests: ProvisionRequestStore,
  ) => EnvironmentProvisionResult | null;
  readonly attach?: () => EnvironmentProvisionAttachResult | null;
  readonly pair?: () => EnvironmentId | null;
  readonly isConnected?: () => boolean;
  readonly canReach?: () => boolean;
  readonly waitForProject?: () => ProjectId | null;
}) {
  const calls: string[] = [];
  const phases: string[] = [];
  const randomUUID = vi.fn(() => "00000000-0000-4000-8000-000000000001");
  // Every step here answers on the first call, so a retry is never expected to be scheduled.
  const schedule = vi.fn(() => () => {});
  const storage = memoryStorage();
  const requests = createProvisionRequestStore({ storage, randomUUID, schedule });
  const leases = createProvisionedSandboxLeaseStore(storage);
  const ports: CloudProvisionPorts = {
    requests,
    leases,
    provision: async (request) => {
      calls.push(`provision:${request.input.requestId}`);
      return answers.provision
        ? answers.provision(request.input.requestId, requests)
        : { kind: "ready", requestId: request.input.requestId, environment: readyEnvironment };
    },
    attach: async (request) => {
      calls.push(`attach:${request.input.requestId}`);
      return answers.attach
        ? answers.attach()
        : {
            kind: "attached",
            environmentId: preparedEnvironmentId,
            pairingUrl: "https://3001-sandbox.e2b.app/pair#token=fresh",
          };
    },
    pair: async (pairingUrl) => {
      calls.push(`pair:${pairingUrl}`);
      return answers.pair ? answers.pair() : preparedEnvironmentId;
    },
    isConnected: answers.isConnected ?? (() => false),
    canReach: answers.canReach ?? (() => true),
    waitForProject: async (environmentId, timeoutMs) => {
      calls.push(`waitForProject:${environmentId}:${timeoutMs}`);
      return answers.waitForProject ? answers.waitForProject() : ProjectId.make("project");
    },
    onPhase: (phase) => {
      phases.push(phase);
    },
  };
  return { calls, phases, randomUUID, schedule, requests, leases, ports };
}

describe("provisionCloudEnvironment", () => {
  it("advances through the phases in order and points the draft at the published project", async () => {
    const { calls, phases, ports } = harness({});

    expect(await provisionCloudEnvironment(draft, ports)).toEqual({
      kind: "ready",
      projectRef: { environmentId: "prepared", projectId: "project" },
    });
    expect(phases).toEqual(["creating", "pairing", "loading-project"]);
    expect(calls).toEqual([
      "provision:00000000-0000-4000-8000-000000000001",
      "attach:00000000-0000-4000-8000-000000000001",
      "pair:https://3001-sandbox.e2b.app/pair#token=fresh",
      "waitForProject:prepared:120000",
    ]);
  });

  it("retries the draft's existing request instead of provisioning a second machine", async () => {
    let attachAttempts = 0;
    const { calls, randomUUID, ports } = harness({
      // The manager is unreachable the first time the draft asks for a link, then answers.
      attach: () =>
        attachAttempts++ === 0
          ? null
          : {
              kind: "attached",
              environmentId: preparedEnvironmentId,
              pairingUrl: "https://3001-sandbox.e2b.app/pair#token=fresh",
            },
    });

    expect(await provisionCloudEnvironment(draft, ports)).toEqual({
      kind: "failed",
      message: "The environment is ready, but a connection could not be issued.",
    });
    expect((await provisionCloudEnvironment(draft, ports)).kind).toBe("ready");
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.startsWith("provision:"))).toEqual([
      "provision:00000000-0000-4000-8000-000000000001",
      "provision:00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("ends in failed carrying the manager's message when it refuses", async () => {
    const { calls, leases, ports } = harness({
      provision: (requestId) => ({
        kind: "refused",
        requestId,
        reason: "credentials",
        message: "No Codex credentials are stored for codex-account.",
      }),
    });

    expect(await provisionCloudEnvironment(draft, ports)).toEqual({
      kind: "failed",
      message: "No Codex credentials are stored for codex-account.",
    });
    expect(calls).toEqual(["provision:00000000-0000-4000-8000-000000000001"]);
    expect(leases.leaseFor("draft")).toBeNull();
  });

  it("stops polling as soon as the draft cancels its request", async () => {
    const { calls, phases, schedule, leases, ports } = harness({
      // The draft is cancelled while the manager's "still preparing" answer is in flight.
      provision: (requestId, requests) => {
        requests.cancel("draft");
        return { kind: "pending", requestId, message: PROVISION_IN_PROGRESS_MESSAGE };
      },
    });

    expect(await provisionCloudEnvironment(draft, ports)).toEqual({ kind: "cancelled" });
    expect(calls).toEqual(["provision:00000000-0000-4000-8000-000000000001"]);
    expect(phases).toEqual(["creating"]);
    expect(schedule).not.toHaveBeenCalled();
    expect(leases.leaseFor("draft")).toBeNull();
  });

  it("records the lease under the draft so the first turn can claim it", async () => {
    const { leases, ports } = harness({});
    const threadRef = { environmentId: preparedEnvironmentId, threadId: ThreadId.make("thread") };

    await provisionCloudEnvironment(draft, ports);

    expect(leases.leaseFor("draft")).toEqual({
      leaseId: "lease",
      sandboxId: "sandbox",
      managerEnvironmentId: "manager",
    });
    leases.transfer("draft", threadRef);
    expect(leases.leaseFor("draft")).toBeNull();
    expect(leases.leaseFor(threadRef)).toEqual({
      leaseId: "lease",
      sandboxId: "sandbox",
      managerEnvironmentId: "manager",
    });
  });

  it("keeps the lease when the machine never publishes its project", async () => {
    const { leases, ports } = harness({ waitForProject: () => null });

    expect(await provisionCloudEnvironment(draft, ports)).toEqual({
      kind: "failed",
      message:
        "E2B ready, but its project is still loading. Open a new E2B chat after the project appears.",
    });
    expect(leases.leaseFor("draft")?.sandboxId).toBe("sandbox");
  });

  it("does not mint a pairing link for a machine this client is already connected to", async () => {
    const { calls, ports } = harness({ isConnected: () => true });

    expect((await provisionCloudEnvironment(draft, ports)).kind).toBe("ready");
    expect(calls).toEqual([
      "provision:00000000-0000-4000-8000-000000000001",
      "waitForProject:prepared:120000",
    ]);
  });

  it("names the pairing failure after the provider that was created", async () => {
    const { ports } = harness({ pair: () => null });

    expect(
      await provisionCloudEnvironment(
        { ...draft, input: { ...draft.input, provider: "namespace" } },
        ports,
      ),
    ).toEqual({
      kind: "failed",
      message: "Namespace Mac was created but could not be connected.",
    });
  });
});

describe("offeredProvisionProviders", () => {
  it("offers what the server advertises", () => {
    expect(
      offeredProvisionProviders({ environmentControl: true, provisionProviders: ["e2b"] }),
    ).toEqual(["e2b"]);
    expect(
      offeredProvisionProviders({
        environmentControl: true,
        provisionProviders: ["e2b", "namespace"],
      }),
    ).toEqual(["e2b", "namespace"]);
    expect(offeredProvisionProviders({ environmentControl: true, provisionProviders: [] })).toEqual(
      [],
    );
  });

  it("offers every kind on an older server that only sets the control flag", () => {
    expect(offeredProvisionProviders({ environmentControl: true })).toEqual(["e2b", "namespace"]);
    expect(offeredProvisionProviders({})).toEqual([]);
    expect(offeredProvisionProviders(null)).toEqual([]);
  });
});

describe("newChatProject", () => {
  const host = EnvironmentId.make("host");
  const box = EnvironmentId.make("box");
  const laptop = EnvironmentId.make("laptop");
  const copy = (environmentId: EnvironmentId, repository = "megpt-mono") => ({
    environmentId,
    id: ProjectId.make(`${repository}@${environmentId}`),
    repository,
  });
  type Copy = ReturnType<typeof copy>;
  const refOf = (project: Copy) => ({
    environmentId: project.environmentId,
    projectId: project.id,
  });
  const connected: NewChatEnvironmentState = { connection: { phase: "connected" } };
  const paused: NewChatEnvironmentState = { connection: { phase: "reconnecting" } };
  const gone: NewChatEnvironmentState = {
    connection: { phase: "error", blockedReason: "workspace-missing" },
  };
  const place = (input: {
    readonly requested: Copy | null;
    readonly projects: ReadonlyArray<Copy>;
    readonly boxes?: ReadonlyArray<EnvironmentId>;
    readonly states?: Readonly<Record<string, NewChatEnvironmentState>>;
  }) =>
    newChatProject({
      requested: input.requested ? refOf(input.requested) : null,
      projects: input.projects,
      logicalProjectKey: (project) => project.repository,
      boxes: new Set(input.boxes ?? []),
      environmentState: (environmentId) => input.states?.[environmentId] ?? connected,
    })?.id ?? null;

  // What the host lists for the box holding a copy of megpt-mono, how the client sees it, and
  // where a new chat goes when the host holds no copy of its own. A box the host has not listed
  // yet reads as any offline machine, so with nothing better it is kept.
  const boxStates = {
    none: null,
    "claimed and paused": { listed: true, state: paused, withoutHost: null },
    "claimed and running": { listed: true, state: connected, withoutHost: null },
    unclaimed: { listed: true, state: connected, withoutHost: null },
    "paused, before the host's list arrives": {
      listed: false,
      state: paused,
      withoutHost: "megpt-mono@box",
    },
    gone: { listed: false, state: gone, withoutHost: null },
    missing: { listed: true, state: gone, withoutHost: null },
  } as const;
  // The chat in view is on its box, so a chat route asks for the box's copy. Every other page has
  // no chat in view and asks for the first project in sidebar order, which here is also the box's.
  const routes = ["chat", "/automations", "/usage", "/settings", "/"] as const;
  const cases = routes.flatMap((route) =>
    Object.entries(boxStates).flatMap(([boxState, boxInfo]) =>
      [true, false].flatMap((onHost) => {
        if (!boxInfo && !onHost) return [];
        const projects = [
          ...(boxInfo ? [copy(box)] : []),
          ...(onHost ? [copy(host)] : []),
          copy(host, "t3code"),
        ];
        return [
          {
            route,
            boxState,
            onHost,
            projects,
            requested: projects[0]!,
            boxes: boxInfo?.listed ? [box] : [],
            states: { [box]: boxInfo?.state ?? connected, [host]: connected },
            expected: onHost ? "megpt-mono@host" : (boxInfo?.withoutHost ?? null),
          },
        ];
      }),
    ),
  );

  it.each(cases)(
    "from $route with a box that is $boxState, host holds the project: $onHost",
    ({ requested, projects, boxes, states, expected }) => {
      expect(place({ requested, projects, boxes, states })).toBe(expected);
    },
  );

  it("keeps a requested copy on a machine that is not a box", () => {
    expect(
      place({ requested: copy(laptop), projects: [copy(host), copy(laptop)], boxes: [box] }),
    ).toBe("megpt-mono@laptop");
  });

  it("moves off a disconnected copy when a connected one exists, else keeps it", () => {
    const projects = [copy(laptop), copy(host)];
    const offline = { [laptop]: { connection: { phase: "offline" } } } as const;
    expect(place({ requested: copy(laptop), projects, states: offline })).toBe("megpt-mono@host");
    expect(place({ requested: copy(laptop), projects: [copy(laptop)], states: offline })).toBe(
      "megpt-mono@laptop",
    );
  });

  it("starts from the first connected project off every box when nothing is requested", () => {
    expect(
      place({
        requested: null,
        projects: [copy(box), copy(laptop, "t3code"), copy(host)],
        boxes: [box],
        states: { [laptop]: paused },
      }),
    ).toBe("megpt-mono@host");
  });

  it("places nothing it does not know", () => {
    expect(place({ requested: copy(laptop), projects: [copy(host)] })).toBeNull();
  });
});

describe("newChatRunTargets", () => {
  const host = { environmentId: EnvironmentId.make("host") };
  const laptop = { environmentId: EnvironmentId.make("laptop") };
  const box = { environmentId: EnvironmentId.make("box") };
  type ManagerConfig = Pick<ServerConfig, "environmentControl" | "provisionProviders">;
  const manager: ManagerConfig = {
    environmentControl: true,
    provisionProviders: ["e2b", "namespace"],
  };
  const noCloud: ManagerConfig = { environmentControl: true, provisionProviders: [] };
  const cloudOnlyHost = { serverConfig: { localAgentRuns: false } };
  const expired = { connection: { blockedReason: "workspace-missing" as const } };
  const targets = (input: {
    readonly localAgentRuns: boolean | undefined;
    readonly environmentId?: EnvironmentId;
    readonly managerConfig?: ManagerConfig;
  }) =>
    newChatRunTargets({
      environments: [host, laptop],
      environmentState: (id) =>
        id !== host.environmentId
          ? { serverConfig: { localAgentRuns: true } }
          : input.localAgentRuns === undefined
            ? {}
            : { serverConfig: { localAgentRuns: input.localAgentRuns } },
      environmentId: input.environmentId ?? host.environmentId,
      managerConfig: input.managerConfig ?? manager,
      boxes: new Set(),
    });

  it("hides a host without local runs and sends its chats to the first cloud kind", () => {
    expect(targets({ localAgentRuns: false })).toEqual({
      environments: [laptop],
      cloudProviders: ["e2b", "namespace"],
      redirect: { kind: "cloud", provider: "e2b" },
    });
  });

  it("moves a host chat to an environment that runs agents when no cloud kind is offered", () => {
    expect(targets({ localAgentRuns: false, managerConfig: noCloud }).redirect).toEqual({
      kind: "environment",
      environment: laptop,
    });
  });

  it("keeps a chat that points elsewhere where it is", () => {
    expect(
      targets({ localAgentRuns: false, environmentId: laptop.environmentId }).redirect,
    ).toBeNull();
  });

  it("offers the host and keeps chats there when the switch is on or absent", () => {
    for (const localAgentRuns of [true, undefined]) {
      expect(targets({ localAgentRuns })).toEqual({
        environments: [host, laptop],
        cloudProviders: ["e2b", "namespace"],
        redirect: null,
      });
    }
  });

  it("has nowhere to send a chat when nothing else can run it", () => {
    expect(
      newChatRunTargets({
        environments: [host],
        environmentState: () => cloudOnlyHost,
        environmentId: host.environmentId,
        managerConfig: noCloud,
        boxes: new Set(),
      }),
    ).toEqual({ environments: [], cloudProviders: [], redirect: null });
  });

  describe("a chat on an expired box", () => {
    const onExpiredBox = (input: {
      readonly environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
      readonly hostRunsAgents: boolean;
      readonly managerConfig: ManagerConfig;
    }) =>
      newChatRunTargets({
        environments: input.environments,
        environmentState: (id) =>
          id === box.environmentId
            ? expired
            : id === host.environmentId && !input.hostRunsAgents
              ? cloudOnlyHost
              : {},
        environmentId: box.environmentId,
        managerConfig: input.managerConfig,
        boxes: new Set(),
      });

    it("moves to a cloud-only host that can start a cloud kind instead", () => {
      expect(
        onExpiredBox({
          environments: [host, laptop, box],
          hostRunsAgents: false,
          managerConfig: manager,
        }),
      ).toEqual({
        environments: [laptop],
        cloudProviders: ["e2b", "namespace"],
        redirect: { kind: "environment", environment: host },
      });
    });

    it("skips a cloud-only host that can start nothing", () => {
      expect(
        onExpiredBox({
          environments: [host, laptop, box],
          hostRunsAgents: false,
          managerConfig: noCloud,
        }).redirect,
      ).toEqual({ kind: "environment", environment: laptop });
    });

    it("moves to a local install that runs agents", () => {
      expect(
        onExpiredBox({ environments: [host, box], hostRunsAgents: true, managerConfig: manager })
          .redirect,
      ).toEqual({ kind: "environment", environment: host });
    });

    it("stays when no live environment holds the project", () => {
      expect(
        onExpiredBox({ environments: [box], hostRunsAgents: true, managerConfig: manager }),
      ).toEqual({ environments: [], cloudProviders: ["e2b", "namespace"], redirect: null });
    });
  });

  it("keeps a chat on a box that is only disconnected", () => {
    expect(
      newChatRunTargets({
        environments: [host, box],
        environmentState: (id) =>
          id === box.environmentId ? { connection: { blockedReason: "authentication" } } : {},
        environmentId: box.environmentId,
        managerConfig: manager,
        boxes: new Set(),
      }).redirect,
    ).toBeNull();
  });

  describe("with cloud boxes other chats run on", () => {
    const remote = { environmentId: EnvironmentId.make("remote") };
    const namespaceBox = { environmentId: EnvironmentId.make("namespace-box") };
    const withBoxes = (input: {
      readonly environmentId: EnvironmentId;
      readonly managerConfig?: ManagerConfig;
    }) =>
      newChatRunTargets({
        environments: [host, box, laptop, namespaceBox, remote],
        environmentState: (id) => (id === host.environmentId ? cloudOnlyHost : {}),
        environmentId: input.environmentId,
        managerConfig: input.managerConfig ?? manager,
        boxes: new Set([box.environmentId, namespaceBox.environmentId]),
      });

    it("offers servers that run agents and fresh cloud kinds, never a running box", () => {
      expect(withBoxes({ environmentId: laptop.environmentId })).toEqual({
        environments: [laptop, remote],
        cloudProviders: ["e2b", "namespace"],
        redirect: null,
      });
    });

    it("starts a chat that points at a running box on a fresh one", () => {
      expect(withBoxes({ environmentId: box.environmentId }).redirect).toEqual({
        kind: "cloud",
        provider: "e2b",
      });
    });

    it("moves a chat on a running box to a server when no cloud kind is offered", () => {
      expect(
        withBoxes({ environmentId: namespaceBox.environmentId, managerConfig: noCloud }),
      ).toEqual({
        environments: [laptop, remote],
        cloudProviders: [],
        redirect: { kind: "environment", environment: laptop },
      });
    });

    it("moves a chat off an expired box to a server, skipping running boxes", () => {
      expect(
        newChatRunTargets({
          environments: [box, namespaceBox, remote],
          environmentState: (id) => (id === box.environmentId ? expired : {}),
          environmentId: box.environmentId,
          managerConfig: manager,
          boxes: new Set([box.environmentId, namespaceBox.environmentId]),
        }).redirect,
      ).toEqual({ kind: "environment", environment: remote });
    });
  });
});

describe("boxesOfOtherChats", () => {
  const host = EnvironmentId.make("host");
  const laptop = { environmentId: EnvironmentId.make("laptop") };
  const draftThread = ThreadId.make("draft-thread");
  const box = (environmentId: string, threadId: string | null) => ({
    managerId: host,
    environmentId: EnvironmentId.make(environmentId),
    leaseId: `${environmentId}-lease`,
    threadId: threadId === null ? null : ThreadId.make(threadId),
    lifecycle: "active" as const,
  });
  const chatBox = box("chat-x-box", "chat-x");
  const automationBox = box("automation-box", "automation-run");
  const manager = {
    environmentControl: true,
    provisionProviders: ["e2b", "namespace"] as const,
  };

  it("counts boxes claimed by other chats or automation runs, never an unclaimed one", () => {
    expect(
      boxesOfOtherChats([chatBox, automationBox, box("fresh-box", null)], draftThread),
    ).toEqual(
      new Map([
        [chatBox.environmentId, host],
        [automationBox.environmentId, host],
      ]),
    );
  });

  it("never counts the draft's own box through the handoff to its first turn", () => {
    const own = (threadId: string | null) =>
      boxesOfOtherChats([chatBox, box("own-box", threadId)], draftThread);
    // Created, pairing, or paired with the first turn under way but not yet claimed.
    expect(own(null)).toEqual(new Map([[chatBox.environmentId, host]]));
    // Claimed by the draft's thread.
    expect(own("draft-thread")).toEqual(new Map([[chatBox.environmentId, host]]));
  });

  it("sends a draft on another chat's box to a fresh box, even after its own box failed to pair", () => {
    const hostEnvironment = { environmentId: host };
    const failedPairing = box("failed-pairing-box", null);
    expect(
      newChatRunTargets({
        environments: [hostEnvironment, chatBox, laptop],
        environmentState: (id) => (id === host ? { serverConfig: { localAgentRuns: false } } : {}),
        environmentId: chatBox.environmentId,
        managerConfig: manager,
        boxes: boxesOfOtherChats([chatBox, failedPairing], draftThread),
      }),
    ).toEqual({
      environments: [laptop],
      cloudProviders: ["e2b", "namespace"],
      redirect: { kind: "cloud", provider: "e2b" },
    });
  });

  it("never offers a paused or lost box, but lets a chat already on one stay", () => {
    const paused = { ...box("paused-box", null), lifecycle: "paused" as const };
    const lost = { ...box("lost-box", null), lifecycle: "missing" as const };
    const targets = (environmentId: EnvironmentId) =>
      newChatRunTargets({
        environments: [paused, lost, laptop],
        environmentState: () => ({}),
        environmentId,
        managerConfig: manager,
        boxes: boxesOfOtherChats([paused, lost], draftThread),
        idleBoxes: idleProvisionedBoxes([paused, lost, chatBox]),
      });
    expect(targets(laptop.environmentId)).toEqual({
      environments: [laptop],
      cloudProviders: ["e2b", "namespace"],
      redirect: null,
    });
    expect(targets(paused.environmentId).redirect).toBeNull();
  });
});

describe("claimFirstTurnBox", () => {
  const host = EnvironmentId.make("host");
  const box = EnvironmentId.make("box");
  const firstThread = { environmentId: box, threadId: ThreadId.make("first-thread") };
  const expectedClaim = {
    environmentId: host,
    input: { leaseId: "lease", environmentId: box, threadId: ThreadId.make("first-thread") },
  };
  const provisionedHere = () => {
    const leases = createProvisionedSandboxLeaseStore(memoryStorage());
    leases.rememberForEnvironment(box, {
      leaseId: "lease",
      sandboxId: "sandbox",
      managerEnvironmentId: host,
    });
    return leases;
  };

  it("claims the box for its first thread, retrying a failed claim once", async () => {
    const leases = provisionedHere();
    const claims: unknown[] = [];
    const claim = async (request: unknown) => {
      claims.push(request);
      return claims.length > 1;
    };
    const warnings: number[] = [];
    const ports = {
      claim,
      refresh: () => undefined,
      warn: (attempt: number) => void warnings.push(attempt),
    };
    await expect(claimFirstTurnBox(leases, ports, firstThread)).resolves.toBe(true);
    expect(claims).toEqual([expectedClaim, expectedClaim]);
    expect(warnings).toEqual([1]);
    expect(leases.leaseFor(firstThread)).toEqual({
      leaseId: "lease",
      sandboxId: "sandbox",
      managerEnvironmentId: host,
    });
    // A later chat on the same box finds nothing left to claim.
    await expect(
      claimFirstTurnBox(leases, ports, { environmentId: box, threadId: ThreadId.make("later") }),
    ).resolves.toBe(false);
    expect(claims).toHaveLength(2);
  });

  it("gives up after the retry without failing the send", async () => {
    const claims: unknown[] = [];
    const claim = async (request: unknown) => {
      claims.push(request);
      throw new Error("host unreachable");
    };
    const warnings: number[] = [];
    const refreshed: EnvironmentId[] = [];
    const ports = {
      claim,
      refresh: (managerId: EnvironmentId) => void refreshed.push(managerId),
      warn: (attempt: number) => void warnings.push(attempt),
    };
    await expect(claimFirstTurnBox(provisionedHere(), ports, firstThread)).resolves.toBe(false);
    expect(claims).toEqual([expectedClaim, expectedClaim]);
    expect(warnings).toEqual([1, 2]);
    expect(refreshed).toEqual([]);
  });

  it("refetches the host's list after a claim, so the next draft sees the box taken", async () => {
    // The host's record of who claimed the box, and this client's copy of its list.
    let owner: ThreadId | null = null;
    const hostList = () => [
      {
        managerId: host,
        environmentId: box,
        leaseId: "lease",
        threadId: owner,
        lifecycle: "active" as const,
      },
    ];
    let clientList = hostList();
    const ports = {
      claim: async ({ input }: ProvisionedBoxClaim) => {
        owner = ThreadId.make(input.threadId);
        return true;
      },
      refresh: (managerId: EnvironmentId) => {
        expect(managerId).toBe(host);
        clientList = hostList();
      },
      warn: () => undefined,
    };
    const nextDraft = ThreadId.make("next-draft");
    expect(boxesOfOtherChats(clientList, nextDraft)).toEqual(new Map());
    await expect(claimFirstTurnBox(provisionedHere(), ports, firstThread)).resolves.toBe(true);
    expect(boxesOfOtherChats(clientList, nextDraft)).toEqual(new Map([[box, host]]));
  });
});

describe("nextDraftEnvironment", () => {
  const host = { environmentId: EnvironmentId.make("host"), projectId: "on-host" };
  const box = { environmentId: EnvironmentId.make("box"), projectId: "on-box" };
  const laptop = { environmentId: EnvironmentId.make("laptop"), projectId: "on-laptop" };

  it("opens the next draft on the box's host, never the box the chat just took", () => {
    expect(
      nextDraftEnvironment({
        environmentId: box.environmentId,
        ownBoxManagerId: host.environmentId,
        environments: [box, host, laptop],
        runTargets: [box, laptop],
      }),
    ).toEqual(host);
  });

  it("falls back to another machine that runs chats when the host lacks the project", () => {
    expect(
      nextDraftEnvironment({
        environmentId: box.environmentId,
        ownBoxManagerId: host.environmentId,
        environments: [box, laptop],
        runTargets: [box, laptop],
      }),
    ).toEqual(laptop);
  });

  it("keeps the next draft where the chat started when it took no box", () => {
    expect(
      nextDraftEnvironment({
        environmentId: laptop.environmentId,
        ownBoxManagerId: null,
        environments: [host, laptop],
        runTargets: [laptop],
      }),
    ).toBeNull();
  });
});
