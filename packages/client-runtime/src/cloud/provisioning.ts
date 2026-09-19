import type {
  EnvironmentId,
  EnvironmentProvisionAttachResult,
  EnvironmentProvisionInput,
  EnvironmentProvisionResult,
  ProjectId,
  ScopedProjectRef,
} from "@t3tools/contracts";

import { joinProvisionedEnvironment } from "../connection/provisioned.ts";
import { scopeProjectRef } from "../environment/scoped.ts";
import type { DraftProvisionRequest, ProvisionRequestStore } from "./provisionRequests.ts";
import type { ProvisionedSandboxLeaseStore } from "./provisionedSandboxLeases.ts";

export type CloudProvisioningPhase =
  | "creating"
  | "pairing"
  | "loading-project"
  | "ready"
  | "failed";
/** The phases the flow passes through on its own; `ready` and `failed` are its outcome. */
export type CloudProvisioningProgressPhase = Exclude<CloudProvisioningPhase, "ready" | "failed">;

/** How long a freshly paired environment gets to publish its cloned project. */
export const CLOUD_PROJECT_HANDOFF_TIMEOUT_MS = 120_000;

export function cloudEnvironmentLabel(provider: EnvironmentProvisionInput["provider"]): string {
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
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
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
  | { readonly kind: "ready"; readonly projectRef: ScopedProjectRef }
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
    });
    if (!stillThisRequest()) return { kind: "cancelled" };
    ports.onPhase("pairing");
    const joined = await joinProvisionedEnvironment(environment, {
      isConnected: ports.isConnected,
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
    return { kind: "ready", projectRef: scopeProjectRef(environment.environmentId, projectId) };
  } catch (error) {
    if (!requests.isActive(draft.draftId)) return { kind: "cancelled" };
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "Could not prepare the environment.",
    };
  }
}
