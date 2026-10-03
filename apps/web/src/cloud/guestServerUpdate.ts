import type { ProvisionedSandboxLease } from "@t3tools/client-runtime/cloud";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  EnvironmentProvisionUpgradeResult,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { provisionedSandboxOwnedByEnvironment } from "./provisionedSandboxLeases";

/**
 * How a version-skewed server gets onto the client's version. A server that
 * advertises a self-update path keeps it. A provisioned guest without one is
 * upgraded by the manager that owns its lease, since the public `npx t3`
 * package is the wrong build for a fork guest. Anything else gets the command.
 */
export type ServerUpdatePath =
  | { readonly kind: "self-update"; readonly capability: ServerSelfUpdateCapability }
  | { readonly kind: "manager-upgrade"; readonly lease: ProvisionedSandboxLease }
  | { readonly kind: "manual-command" };

export function resolveServerUpdatePath({
  selfUpdate,
  lease,
}: {
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly lease: ProvisionedSandboxLease | null;
}): ServerUpdatePath {
  if (selfUpdate !== null) return { kind: "self-update", capability: selfUpdate };
  if (lease !== null) return { kind: "manager-upgrade", lease };
  return { kind: "manual-command" };
}

/** The update path for a connected environment, using the lease this client holds for it. */
function resolveEnvironmentServerUpdatePath(
  environmentId: EnvironmentId | null,
  selfUpdate: ServerSelfUpdateCapability | null,
): ServerUpdatePath {
  return resolveServerUpdatePath({
    selfUpdate,
    lease: environmentId === null ? null : provisionedSandboxOwnedByEnvironment(environmentId),
  });
}

/** True when this client can update the server itself, by RPC to it or to its manager. */
export function isRemoteServerUpdate(target: {
  readonly environmentId: EnvironmentId;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly desktopAppUpdate?: boolean | undefined;
}): boolean {
  const path = resolveEnvironmentServerUpdatePath(target.environmentId, target.selfUpdate);
  if (path.kind === "manual-command") return false;
  return (
    path.kind !== "self-update" ||
    path.capability !== "desktop-managed" ||
    !!target.desktopAppUpdate
  );
}

/** The update button's label for a guest its manager upgrades; null for any other server. */
export function guestServerUpdateLabel(
  environmentId: EnvironmentId,
  selfUpdate: ServerSelfUpdateCapability | null,
): string | null {
  return resolveEnvironmentServerUpdatePath(environmentId, selfUpdate).kind === "manager-upgrade"
    ? "Update via manager"
    : null;
}

export interface UpgradeResultToast {
  readonly type: "success" | "info" | "error";
  readonly title: string;
  readonly description?: string;
}

export function describeUpgradeResult(
  result: EnvironmentProvisionUpgradeResult,
  serverLabel: string,
): UpgradeResultToast {
  switch (result.kind) {
    case "upgraded":
      return {
        type: "success",
        title: `${serverLabel} updated`,
        description: `Now on ${result.t3Revision.slice(0, 7)}`,
      };
    case "current":
      return { type: "info", title: `${serverLabel} is already on the manager's build` };
    case "refused":
      return {
        type: "error",
        title: `${serverLabel} update refused`,
        description: result.message,
      };
  }
}

/**
 * Updates a provisioned guest through the manager that owns its lease, or returns null, doing
 * nothing, for any other server. The update throws the manager's failure for the caller to report.
 */
export function useGuestServerUpgrade() {
  const upgradeThroughManager = useAtomCommand(serverEnvironment.upgradeProvisionedEnvironment, {
    reportFailure: false,
  });
  return (target: {
    readonly environmentId: EnvironmentId;
    readonly serverLabel: string;
    readonly selfUpdate: ServerSelfUpdateCapability | null;
  }): Promise<void> | null => {
    const path = resolveEnvironmentServerUpdatePath(target.environmentId, target.selfUpdate);
    if (path.kind !== "manager-upgrade") return null;
    const { leaseId, sandboxId, managerEnvironmentId } = path.lease;
    return upgradeThroughManager({
      environmentId: managerEnvironmentId,
      input: { leaseId, sandboxId, environmentId: target.environmentId },
    }).then((result) => {
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        throw squashAtomCommandFailure(result);
      }
      toastManager.add(describeUpgradeResult(result.value, target.serverLabel));
    });
  };
}
