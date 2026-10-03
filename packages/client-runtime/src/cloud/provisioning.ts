import {
  EnvironmentId,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionClaimInput,
  type DiscoveredProvisionedEnvironment,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
  type ProjectId,
  type ProvisionedChat,
  ProvisionProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ServerConfig,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentConnectionPresentation } from "../connection/presentation.ts";
import { joinProvisionedEnvironment } from "../connection/provisioned.ts";
import { scopeProjectRef } from "../environment/scoped.ts";
import type { DraftProvisionRequest, ProvisionRequestStore } from "./provisionRequests.ts";
import type {
  ProvisionedSandboxLease,
  ProvisionedSandboxLeaseStore,
} from "./provisionedSandboxLeases.ts";

export type CloudProvisioningPhase =
  | "creating"
  | "pairing"
  | "loading-project"
  | "ready"
  | "failed";
/** The phases the flow passes through on its own; `ready` and `failed` are its outcome. */
export type CloudProvisioningProgressPhase = Exclude<CloudProvisioningPhase, "ready" | "failed">;

/** How long a freshly paired environment gets to publish its cloned project. */
const CLOUD_PROJECT_HANDOFF_TIMEOUT_MS = 120_000;

/**
 * The cloud environments a manager offers to create. Servers that predate
 * `provisionProviders` only set `environmentControl`, and offered every kind.
 */
export function offeredProvisionProviders(
  config: Pick<ServerConfig, "environmentControl" | "provisionProviders"> | null | undefined,
): ReadonlyArray<ProvisionProvider> {
  if (config?.provisionProviders) return config.provisionProviders;
  return config?.environmentControl === true ? ProvisionProvider.literals : [];
}

/** Whether an environment runs agents on its own machine. Servers that predate the switch did. */
export function runsLocalAgents(
  config: Pick<ServerConfig, "localAgentRuns"> | null | undefined,
): boolean {
  return config?.localAgentRuns !== false;
}

/** What the client knows about one environment when placing a new chat. */
export interface NewChatEnvironmentState {
  readonly serverConfig?: Pick<ServerConfig, "localAgentRuns"> | null | undefined;
  readonly connection?:
    | Partial<Pick<EnvironmentConnectionPresentation, "phase" | "blockedReason">>
    | null
    | undefined;
}

/** Whether an environment's machine is gone for good, such as a cloud box whose lease expired. */
function isEnvironmentGone(state: NewChatEnvironmentState | null | undefined): boolean {
  return state?.connection?.blockedReason === "workspace-missing";
}

/** A cloud box a host reports, with the host that provisioned it. */
export interface ProvisionedBox {
  readonly managerId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly leaseId: string;
  /** The chat the box was claimed for; null until one claims it. */
  readonly threadId: ThreadId | null;
  readonly lifecycle: DiscoveredProvisionedEnvironment["lifecycle"];
  /** The host's name for the box. A saved box's label follows it. */
  readonly label: string;
  /** The host's last read of the box's chat, sent only when newer than this runtime holds. */
  readonly chat: ProvisionedChat | null;
}

/** One host's list of its boxes, as it last answered. */
export interface HostBoxList {
  readonly managerId: EnvironmentId;
  readonly boxes: ReadonlyArray<ProvisionedBox>;
}

/** A host's list row as the runtime reconciles it. */
export function provisionedBox(
  managerId: EnvironmentId,
  row: DiscoveredProvisionedEnvironment,
): ProvisionedBox {
  return {
    managerId,
    environmentId: row.environmentId,
    leaseId: row.leaseId,
    threadId: row.threadId,
    lifecycle: row.lifecycle,
    label: row.label,
    chat: row.chat ?? null,
  };
}

export function sameProvisionedBoxes(
  left: ReadonlyArray<ProvisionedBox>,
  right: ReadonlyArray<ProvisionedBox>,
): boolean {
  return (
    left.length === right.length &&
    left.every((box, index) => {
      const other = right[index]!;
      return (
        box.managerId === other.managerId &&
        box.environmentId === other.environmentId &&
        box.leaseId === other.leaseId &&
        box.threadId === other.threadId &&
        box.lifecycle === other.lifecycle &&
        box.label === other.label &&
        box.chat?.sequence === other.chat?.sequence
      );
    })
  );
}

export interface ProvisionedBoxClaim {
  /** The host that provisioned the box. */
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentProvisionClaimInput;
}

export interface ProvisionedBoxClaimPorts {
  /** One `environmentControl.claim` call; true when the host recorded the owner. */
  readonly claim: (request: ProvisionedBoxClaim) => Promise<boolean>;
  /** The host a saved box connection names, or null when `environmentId` is not a box. */
  readonly boxManager: (environmentId: EnvironmentId) => EnvironmentId | null;
  /** Refetches the host's box list, so drafts on every screen see the claim. */
  readonly refresh: (managerId: EnvironmentId) => void;
  /** Reports an attempt that failed; the caller owns where that is logged. */
  readonly warn: (attempt: number) => void;
}

/**
 * Whether `lease` is for the box `environmentId` reaches: the one its host reported, or on a lease
 * recorded before that, a box this device marked for the lease's host. A draft can keep its lease
 * and still run on a real server, whose chat must never claim the box.
 */
export function leaseReachesBox(
  lease: Pick<ProvisionedSandboxLease, "managerEnvironmentId" | "environmentId">,
  environmentId: EnvironmentId,
  boxManager: (environmentId: EnvironmentId) => EnvironmentId | null,
): boolean {
  return lease.environmentId !== undefined
    ? lease.environmentId === environmentId
    : boxManager(environmentId) === lease.managerEnvironmentId;
}

/**
 * A draft's lease, naming its box from the draft's ready send when the lease predates leases
 * naming their box. Such a box may not be marked yet on its first send, and the ready send is
 * the one record of it. A lease that names its box keeps it.
 */
export function draftBoxLease<
  Lease extends Pick<ProvisionedSandboxLease, "environmentId" | "managerEnvironmentId">,
>(lease: Lease, readyEnvironmentId: string | null): Lease {
  return lease.environmentId !== undefined || readyEnvironmentId === null
    ? lease
    : { ...lease, environmentId: EnvironmentId.make(readyEnvironmentId) };
}

/**
 * Records a thread on the host as the owner of the box its first turn started on, so every
 * device stops offering the box to new chats. Tries twice; a claim that still fails leaves the
 * chat running and is only reported, because the turn has already started.
 */
export async function claimProvisionedBox(
  ports: ProvisionedBoxClaimPorts,
  lease: Pick<ProvisionedSandboxLease, "leaseId" | "managerEnvironmentId" | "environmentId">,
  owner: ScopedThreadRef,
): Promise<boolean> {
  if (!leaseReachesBox(lease, owner.environmentId, ports.boxManager)) return false;
  const request = {
    environmentId: lease.managerEnvironmentId,
    input: { leaseId: lease.leaseId, environmentId: owner.environmentId, threadId: owner.threadId },
  };
  for (const attempt of [1, 2]) {
    if (await ports.claim(request).catch(() => false)) {
      ports.refresh(lease.managerEnvironmentId);
      return true;
    }
    ports.warn(attempt);
  }
  return false;
}

/**
 * Claims the box a first turn started on when this device provisioned it and has not claimed it
 * yet, which is when its lease is still recorded under the environment. False when there is
 * nothing to claim or the claim failed.
 */
export function claimFirstTurnBox(
  leases: Pick<ProvisionedSandboxLeaseStore, "transferFromEnvironment">,
  ports: ProvisionedBoxClaimPorts,
  owner: ScopedThreadRef,
): Promise<boolean> {
  const lease = leases.transferFromEnvironment(owner.environmentId, owner);
  return lease === null ? Promise.resolve(false) : claimProvisionedBox(ports, lease, owner);
}

/**
 * Where a background send opens the next draft, or null to open it where the chat just started.
 * A chat that started on the box it provisioned has taken that box, whether or not its claim has
 * landed yet, so the next draft goes to the box's host, which starts a fresh box when it runs no
 * agents itself, else to the first other machine a new chat can run on.
 */
export function nextDraftEnvironment<
  Environment extends { readonly environmentId: EnvironmentId },
>(input: {
  /** Where the chat just started. */
  readonly environmentId: EnvironmentId;
  /** The host of the box the chat started on, when the chat provisioned that box itself. */
  readonly ownBoxManagerId: EnvironmentId | null;
  /** The environments holding the chat's project. */
  readonly environments: ReadonlyArray<Environment>;
  /** Where a new chat may run, as `newChatRunTargets` offers it. */
  readonly runTargets: ReadonlyArray<Environment>;
}): Environment | null {
  if (input.ownBoxManagerId === null) return null;
  return (
    input.environments.find(({ environmentId }) => environmentId === input.ownBoxManagerId) ??
    input.runTargets.find(({ environmentId }) => environmentId !== input.environmentId) ??
    null
  );
}

/**
 * The project a new chat opens on: `requested`, else the first copy of the same logical project
 * in `projects`, else with nothing requested the first project at all. Only a copy on a user
 * environment, one `environmentState` knows, and never on a gone machine; a cloud box is not a
 * user environment, and every new chat gets a fresh box. A connected copy wins over one that is
 * not, whose files a new chat could not read. The route or chat in view only ever shapes
 * `requested`. Null when only boxes hold the project, or `requested` is not among `projects`.
 */
export function newChatProject<
  Project extends { readonly environmentId: EnvironmentId; readonly id: ProjectId },
>(input: {
  readonly requested: ScopedProjectRef | null;
  /** Every project the client knows, in the order to prefer them. */
  readonly projects: ReadonlyArray<Project>;
  readonly logicalProjectKey: (project: Project) => string;
  /** The user environments' state; null for anything else. */
  readonly environmentState: (
    environmentId: EnvironmentId,
  ) => NewChatEnvironmentState | null | undefined;
}): Project | null {
  const { requested } = input;
  const asked = requested
    ? input.projects.find(
        (project) =>
          project.environmentId === requested.environmentId && project.id === requested.projectId,
      )
    : undefined;
  if (requested && !asked) return null;
  const key = asked ? input.logicalProjectKey(asked) : null;
  const candidates = [...(asked ? [asked] : []), ...input.projects].filter((project) => {
    const state = input.environmentState(project.environmentId);
    return (
      (key === null || input.logicalProjectKey(project) === key) &&
      state != null &&
      !isEnvironmentGone(state)
    );
  });
  return (
    candidates.find(
      (project) => input.environmentState(project.environmentId)?.connection?.phase === "connected",
    ) ??
    candidates[0] ??
    null
  );
}

export interface NewChatRunTargets<Environment> {
  /** The environments holding the project that a new chat may run on. */
  readonly environments: ReadonlyArray<Environment>;
  /** The cloud kinds the manager can create for the chat. */
  readonly cloudProviders: ReadonlyArray<ProvisionProvider>;
  /**
   * Where a chat that cannot start where it points goes instead. A chat on a
   * gone machine moves to the first live environment, not a box, that runs
   * agents or can hand the chat to a cloud kind. A chat on another chat's box,
   * or on a live environment that runs no agents, starts on the manager's
   * first cloud kind, else moves to the first environment that runs them. Null
   * when the chat may stay, or there is nowhere else to go.
   */
  readonly redirect:
    | { readonly kind: "cloud"; readonly provider: ProvisionProvider }
    | { readonly kind: "environment"; readonly environment: Environment }
    | null;
}

/** Where a new chat can run, and where it starts before the user picks. */
export function newChatRunTargets<
  Environment extends { readonly environmentId: EnvironmentId },
>(input: {
  /** The environments holding the chat's project, in the order to prefer them. */
  readonly environments: ReadonlyArray<Environment>;
  readonly environmentState: (
    environmentId: EnvironmentId,
  ) => NewChatEnvironmentState | null | undefined;
  /** The environment the chat points at now. */
  readonly environmentId: EnvironmentId | null;
  readonly managerConfig:
    | Pick<ServerConfig, "environmentControl" | "provisionProviders">
    | null
    | undefined;
  /**
   * Cloud boxes that are not the chat's own. Every new chat gets a fresh box, so none of these
   * is a place to start one.
   */
  readonly boxes?: Pick<ReadonlySet<EnvironmentId>, "has">;
}): NewChatRunTargets<Environment> {
  const cloudProviders = offeredProvisionProviders(input.managerConfig);
  const provider = cloudProviders[0];
  const gone = (environmentId: EnvironmentId) =>
    isEnvironmentGone(input.environmentState(environmentId));
  const box = (environmentId: EnvironmentId) => input.boxes?.has(environmentId) === true;
  const runs = (environmentId: EnvironmentId) =>
    !box(environmentId) && runsLocalAgents(input.environmentState(environmentId)?.serverConfig);
  const environments = input.environments.filter(
    ({ environmentId }) => runs(environmentId) && !gone(environmentId),
  );
  const moveTo = (environment: Environment | undefined) =>
    environment ? ({ kind: "environment", environment } as const) : null;
  const redirect =
    input.environmentId === null
      ? null
      : gone(input.environmentId)
        ? moveTo(
            input.environments.find(
              ({ environmentId }) =>
                !gone(environmentId) &&
                !box(environmentId) &&
                (runs(environmentId) || provider !== undefined),
            ),
          )
        : runs(input.environmentId)
          ? null
          : provider
            ? ({ kind: "cloud", provider } as const)
            : moveTo(environments[0]);
  return { environments, cloudProviders, redirect };
}

function cloudEnvironmentLabel(provider: EnvironmentProvisionInput["provider"]): string {
  return provider === "namespace" ? "Namespace Mac" : "E2B";
}

export interface CloudProvisionDraft {
  readonly draftId: string;
  readonly managerEnvironmentId: EnvironmentId;
  readonly input: Omit<EnvironmentProvisionInput, "requestId">;
}

export interface CloudProvisionPorts {
  readonly requests: ProvisionRequestStore;
  readonly leases: ProvisionedSandboxLeaseStore;
  /** One `environmentControl.provision` call; null when the manager could not be reached. */
  readonly provision: (
    request: DraftProvisionRequest,
  ) => Promise<EnvironmentProvisionResult | null>;
  /** Mints a one-time pairing URL for the prepared environment; null when the call failed. */
  readonly attach: (
    request: DraftProvisionRequest,
  ) => Promise<EnvironmentProvisionAttachResult | null>;
  /** Registers the pairing URL; resolves with the paired environment's id, or null on failure. */
  readonly pair: (pairingUrl: string) => Promise<EnvironmentId | null>;
  readonly rewritePairingUrl?: (pairingUrl: string, leaseId: string) => string;
  /** See `ProvisionedJoinPorts.isPaired`. */
  readonly isPaired: (environmentId: EnvironmentId) => boolean;
  /** See `ProvisionedJoinPorts.canReach`. */
  readonly canReach: (pairingUrl: string) => boolean;
  /** Resolves with the project the paired environment publishes, or null once `timeoutMs` passes. */
  readonly waitForProject: (
    environmentId: EnvironmentId,
    timeoutMs: number,
  ) => Promise<ProjectId | null>;
  readonly onPhase: (phase: CloudProvisioningProgressPhase) => void;
}

export type CloudProvisionOutcome =
  | {
      readonly kind: "ready";
      readonly projectRef: ScopedProjectRef;
      /** The host started the chat's first turn on the box, so the page must not send it. */
      readonly firstTurnStarted: boolean;
    }
  | { readonly kind: "failed"; readonly message: string }
  /** The draft cancelled or replaced its request; there is nothing to show. */
  | { readonly kind: "cancelled" };

/**
 * Takes a draft from "wants a cloud environment" to "points at the cloned project on one".
 * The request is reserved under the draft before anything is dispatched, so a reload resumes
 * the same request, and every step re-checks that the draft still wants this request, so a
 * cancel or a replacement made while a call was in flight wins over that call's result.
 */
export async function provisionCloudEnvironment(
  draft: CloudProvisionDraft,
  ports: CloudProvisionPorts,
): Promise<CloudProvisionOutcome> {
  const { requests, leases } = ports;
  const label = cloudEnvironmentLabel(draft.input.provider);
  try {
    ports.onPhase("creating");
    const request = requests.reserve(draft.draftId, {
      managerEnvironmentId: draft.managerEnvironmentId,
      input: draft.input,
    });
    const stillThisRequest = () => requests.isCurrent(draft.draftId, request.input.requestId);
    const created = await requests.poll(draft.draftId, request, ports.provision);
    if (created.kind === "cancelled" || !stillThisRequest()) return { kind: "cancelled" };
    if (created.kind === "unreachable") {
      return {
        kind: "failed",
        message: "Could not reach the environment manager. Send again to resume.",
      };
    }
    if (created.kind !== "ready") {
      return {
        kind: "failed",
        message:
          created.kind === "refused"
            ? created.message
            : `${created.message} Send again to resume this request.`,
      };
    }
    const environment = created.environment;
    // Recorded before the draft is re-checked: a draft cancelled at this moment still owns a
    // machine, and the lease is what lets deleting that draft dispose it.
    leases.remember(draft.draftId, {
      leaseId: environment.leaseId,
      sandboxId: environment.sandboxId,
      managerEnvironmentId: request.managerEnvironmentId,
      environmentId: environment.environmentId,
    });
    if (!stillThisRequest()) return { kind: "cancelled" };
    ports.onPhase("pairing");
    const joined = await joinProvisionedEnvironment(environment, {
      isPaired: ports.isPaired,
      attach: async () => {
        const attached = await ports.attach(request);
        return attached === null || attached.kind === "refused"
          ? {
              kind: "refused",
              message: "The environment is ready, but a connection could not be issued.",
            }
          : attached;
      },
      pair: async (pairingUrl) => {
        const paired = await ports.pair(pairingUrl);
        if (paired === null) throw new Error(`${label} was created but could not be connected.`);
        return paired;
      },
      ...(ports.rewritePairingUrl
        ? {
            rewritePairingUrl: (pairingUrl: string, lease: { readonly leaseId: string }) =>
              ports.rewritePairingUrl!(pairingUrl, lease.leaseId),
          }
        : {}),
      canReach: ports.canReach,
    });
    if (!stillThisRequest()) return { kind: "cancelled" };
    if (joined.kind !== "joined") {
      return {
        kind: "failed",
        message:
          joined.kind === "refused"
            ? joined.message
            : "This machine is reachable only through the computer that started it.",
      };
    }
    // Pairing is asynchronous: the remote server must publish its cloned project before the
    // draft can point at it. Waiting here keeps the cloud action one user-visible operation
    // rather than leaving a machine stranded on an unrelated local draft.
    ports.onPhase("loading-project");
    const projectId = await ports.waitForProject(
      environment.environmentId,
      CLOUD_PROJECT_HANDOFF_TIMEOUT_MS,
    );
    if (!stillThisRequest()) return { kind: "cancelled" };
    if (projectId === null) {
      // The lease stays on the draft so deleting it still has a path to dispose the machine
      // if project publication was delayed or the remote checkout failed.
      return {
        kind: "failed",
        message: `${label} ready, but its project is still loading. Open a new ${label} chat after the project appears.`,
      };
    }
    return {
      kind: "ready",
      projectRef: scopeProjectRef(environment.environmentId, projectId),
      firstTurnStarted: environment.firstTurn === "started",
    };
  } catch (error) {
    if (!requests.isActive(draft.draftId)) return { kind: "cancelled" };
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "Could not prepare the environment.",
    };
  }
}
