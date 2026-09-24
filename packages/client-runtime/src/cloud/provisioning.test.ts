import {
  EnvironmentId,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionResult,
  ProjectId,
  ProviderDriverKind,
  type ProvisionRequestId,
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
  newChatRunTargets,
  offeredProvisionProviders,
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

describe("newChatRunTargets", () => {
  const host = { environmentId: EnvironmentId.make("host") };
  const laptop = { environmentId: EnvironmentId.make("laptop") };
  const manager = { environmentControl: true, provisionProviders: ["namespace", "e2b"] as const };
  const targets = (
    localAgentRuns: boolean | undefined,
    environmentId: EnvironmentId | null = host.environmentId,
  ) =>
    newChatRunTargets({
      environments: [host, laptop],
      serverConfig: (id) =>
        id === host.environmentId
          ? localAgentRuns === undefined
            ? {}
            : { localAgentRuns }
          : { localAgentRuns: true },
      environmentId,
      managerConfig: manager,
    });

  it("hides a host without local runs and starts its chats on the first cloud kind", () => {
    expect(targets(false)).toEqual({
      environments: [laptop],
      cloudProviders: ["namespace", "e2b"],
      defaultCloudProvider: "namespace",
    });
  });

  it("keeps a chat that points elsewhere where it is", () => {
    expect(targets(false, laptop.environmentId).defaultCloudProvider).toBeNull();
  });

  it("offers the host and keeps chats local when the switch is on or absent", () => {
    for (const localAgentRuns of [true, undefined]) {
      expect(targets(localAgentRuns)).toEqual({
        environments: [host, laptop],
        cloudProviders: ["namespace", "e2b"],
        defaultCloudProvider: null,
      });
    }
  });

  it("has no cloud default when the manager offers none", () => {
    expect(
      newChatRunTargets({
        environments: [host],
        serverConfig: () => ({ localAgentRuns: false }),
        environmentId: host.environmentId,
        managerConfig: { environmentControl: true, provisionProviders: [] },
      }),
    ).toEqual({ environments: [], cloudProviders: [], defaultCloudProvider: null });
  });
});
