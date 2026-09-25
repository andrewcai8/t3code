import {
  provisionCloudEnvironment,
  type CloudProvisioningProgressPhase,
} from "@t3tools/client-runtime/cloud";
import {
  isOffDeviceReachablePairingUrl,
  provisionedGatewayPairingUrl,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useRef, useState } from "react";

import { connectPairing } from "../../connection/onboarding";
import { uuidv4 } from "../../lib/uuid";
import { waitForEnvironmentProject } from "../../state/entities";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { hydrateProvisionStorage } from "../cloud/provisionStorage";
import { provisionRequests, provisionedSandboxLeases } from "../cloud/provisionStores";
import {
  CLOUD_MACHINE_PROVIDER_LABELS,
  type CloudMachineAccountOption,
  type CloudMachineProvider,
} from "./cloudMachineOptions";

export type CreateCloudMachineState =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly phase: CloudProvisioningProgressPhase }
  | { readonly kind: "failed"; readonly message: string };

const IDLE: CreateCloudMachineState = { kind: "idle" };

/** What each phase of the shared flow is called on a screen with no thread to show progress in. */
export function createCloudMachineProgressText(
  phase: CloudProvisioningProgressPhase,
  provider: CloudMachineProvider,
): string {
  const label = CLOUD_MACHINE_PROVIDER_LABELS[provider];
  switch (phase) {
    case "creating":
      return `Starting your ${label} machine…`;
    case "pairing":
      return "Connecting this device to it…";
    case "loading-project":
      return "Waiting for the checkout…";
  }
}

/**
 * Starts a cloud machine from this device and joins it, using the same flow the web composer
 * runs. The phone has no draft to hang the machine on, so each attempt gets its own request
 * identity; the request record is still what a later disposal reads.
 */
export function useCreateCloudMachine(input: {
  readonly managerId: EnvironmentId;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  /** Called with the machine's checkout once it is joined and the checkout has appeared. */
  readonly onCreated: (projectRef: ScopedProjectRef) => void;
}) {
  const { managerId, connectedEnvironments, onCreated } = input;
  const manager = connectedEnvironments.find((entry) => entry.environmentId === managerId);
  const provision = useAtomCommand(serverEnvironment.provisionEnvironment, {
    reportFailure: false,
  });
  const attach = useAtomCommand(serverEnvironment.attachProvisionedEnvironment, {
    reportFailure: false,
  });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const [state, setState] = useState<CreateCloudMachineState>(IDLE);
  // One machine at a time from this screen: a second tap while the first is in flight would
  // allocate a sandbox nobody is waiting for.
  const inFlight = useRef(false);

  const create = useCallback(
    async (selection: {
      readonly repository: string;
      readonly provider: CloudMachineProvider;
      readonly account: CloudMachineAccountOption;
    }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setState({ kind: "working", phase: "creating" });
      // The request record has to be readable before one is reserved, or a machine started
      // just before an app kill would have no record to dispose it by.
      await hydrateProvisionStorage();
      try {
        const outcome = await provisionCloudEnvironment(
          {
            draftId: `mobile-cloud-machine:${uuidv4()}`,
            managerEnvironmentId: managerId,
            input: {
              provider: selection.provider,
              providerInstanceId: selection.account.instanceId,
              agentDriver: selection.account.driver,
              repository: selection.repository,
            },
          },
          {
            requests: provisionRequests,
            leases: provisionedSandboxLeases,
            provision: async (request) => {
              const result = await provision({
                environmentId: request.managerEnvironmentId,
                input: request.input,
              });
              return AsyncResult.isSuccess(result) ? result.value : null;
            },
            attach: async (request) => {
              const result = await attach({
                environmentId: request.managerEnvironmentId,
                input: { requestId: request.input.requestId },
              });
              return AsyncResult.isSuccess(result) ? result.value : null;
            },
            pair: async (pairingUrl) => {
              const result = await pair({ pairingUrl });
              return AsyncResult.isSuccess(result) ? result.value : null;
            },
            ...(manager?.displayUrl
              ? {
                  rewritePairingUrl: (pairingUrl: string, leaseId: string) =>
                    provisionedGatewayPairingUrl(manager.displayUrl, leaseId, pairingUrl),
                }
              : {}),
            isConnected: (environmentId) =>
              connectedEnvironments.some((entry) => entry.environmentId === environmentId),
            // A phone is never the machine that started the box, so a loopback pairing URL is
            // one it cannot reach however healthy the box is.
            canReach: isOffDeviceReachablePairingUrl,
            waitForProject: (environmentId, timeoutMs) =>
              waitForEnvironmentProject(environmentId, timeoutMs).then(
                (project) => project?.id ?? null,
              ),
            onPhase: (phase) => setState({ kind: "working", phase }),
          },
        );
        if (outcome.kind === "failed") {
          setState({ kind: "failed", message: outcome.message });
          return;
        }
        setState(IDLE);
        if (outcome.kind === "ready") onCreated(outcome.projectRef);
      } finally {
        inFlight.current = false;
      }
    },
    [attach, connectedEnvironments, manager, managerId, onCreated, pair, provision],
  );

  const dismissError = useCallback(() => setState(IDLE), []);

  return { state, create, dismissError };
}
