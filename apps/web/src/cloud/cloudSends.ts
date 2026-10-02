import {
  type CloudSendDriverPorts,
  type CloudSendStep,
  createCloudSendDriver,
  createTabExclusive,
} from "@t3tools/client-runtime/cloud";
import { holdsPairing, provisionedGatewayPairingUrl } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

import { toastManager } from "../components/ui/toast";
import {
  DraftId,
  type PendingCloudEnvironmentSend,
  useComposerDraftStore,
} from "../composerDraftStore";
import { environmentCatalog } from "../connection/catalog";
import { connectPairing } from "../connection/onboarding";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { waitForProjectMatch } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { readPreparedConnection } from "../state/session";
import { holdBoxDemand } from "./CloudBoxes";
import { provisionRequests } from "./provisionRequests";
import { provisionedSandboxLeases } from "./provisionedSandboxLeases";

const quietly = { reportFailure: false };

export function patchDraftPendingEnvironmentSend(
  draftId: DraftId,
  patch: Partial<PendingCloudEnvironmentSend>,
): void {
  const store = useComposerDraftStore.getState();
  const current = store.getDraftSession(draftId)?.pendingEnvironmentSend;
  if (!current) return;
  store.setDraftPendingEnvironmentSend(draftId, { ...current, ...patch });
}

/** Writes a step onto the draft; its view, wherever it is open, follows the draft. */
export function recordCloudSendStep(id: string, step: CloudSendStep): void {
  const draftId = DraftId.make(id);
  const store = useComposerDraftStore.getState();
  const pending = store.getDraftSession(draftId)?.pendingEnvironmentSend;
  switch (step.kind) {
    case "progress":
      patchDraftPendingEnvironmentSend(draftId, { phase: step.phase });
      return;
    case "failed":
      if (!pending) return;
      patchDraftPendingEnvironmentSend(draftId, {
        phase: "failed",
        endedAt: new Date().toISOString(),
        error: step.message,
      });
      toastManager.add({ type: "error", title: step.message });
      return;
    case "cancelled":
      store.setDraftPendingEnvironmentSend(draftId, null);
      return;
    case "ready":
      if (!pending) return;
      if (pending.modelSelection) store.setModelSelection(draftId, pending.modelSelection);
      store.setDraftThreadContext(draftId, {
        projectRef: step.projectRef,
        // The sandbox itself is the isolation boundary. Do not try to create
        // a second worktree inside its already-cloned checkout, which would
        // require a base branch the draft does not have after pairing.
        envMode: "local",
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
        environmentSelection: "manual",
      });
      patchDraftPendingEnvironmentSend(draftId, {
        phase: "ready",
        readyEnvironmentId: step.projectRef.environmentId,
        ...(step.firstTurnStarted ? { hostStartedFirstTurn: true } : {}),
      });
  }
}

const hostPorts: CloudSendDriverPorts["host"] = (request) => {
  const managerId = request.managerEnvironmentId;
  return {
    provision: async (provisioned) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.provisionEnvironment,
        { environmentId: managerId, input: provisioned.input, showsOwnProgress: true },
        quietly,
      );
      return AsyncResult.isSuccess(result) ? result.value : null;
    },
    attach: async (attached) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        serverEnvironment.attachProvisionedEnvironment,
        {
          environmentId: managerId,
          input: { requestId: attached.input.requestId },
          showsOwnProgress: true,
        },
        quietly,
      );
      return AsyncResult.isSuccess(result) ? result.value : null;
    },
    pair: async (pairingUrl) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        connectPairing,
        { pairingUrl, box: { managerId } },
        quietly,
      );
      return AsyncResult.isSuccess(result) ? result.value : null;
    },
    rewritePairingUrl: (pairingUrl, leaseId) => {
      // Read when pairing, since a page that just loaded may still be connecting to the host.
      const managerBaseUrl = readPreparedConnection(managerId)?.httpBaseUrl;
      return managerBaseUrl
        ? provisionedGatewayPairingUrl(managerBaseUrl, leaseId, pairingUrl)
        : pairingUrl;
    },
    isPaired: (environmentId) =>
      holdsPairing(
        appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.get(environmentId),
      ),
    // The browser may be running on the manager itself, where even a loopback link works.
    canReach: () => true,
    waitForProject: (environmentId, timeoutMs) => {
      // The box publishes its project over its connection; the draft holds it once ready.
      const release = holdBoxDemand(environmentId);
      return waitForProjectMatch((project) => project.environmentId === environmentId, timeoutMs)
        .then(
          (project) => project.id,
          () => null,
        )
        .finally(release);
    },
  };
};

const tabExclusive = createTabExclusive();

/**
 * Web Locks span every tab of this origin. They exist only on secure origins, so a plain-HTTP
 * LAN origin falls back to this tab alone, and there the box's host turns away a second start
 * of the same thread.
 */
const exclusive: CloudSendDriverPorts["exclusive"] = (key, task) =>
  globalThis.navigator?.locks
    ? globalThis.navigator.locks.request(`t3code:${key}`, task)
    : tabExclusive(key, task);

export const cloudSends = createCloudSendDriver({
  requests: provisionRequests,
  leases: provisionedSandboxLeases,
  host: hostPorts,
  record: recordCloudSendStep,
  exclusive,
});

/** Picks up every draft whose cloud send a closed or reloaded page left mid-setup. */
export function resumeCloudSends(): void {
  const { draftThreadsByThreadKey } = useComposerDraftStore.getState();
  for (const [draftId, draft] of Object.entries(draftThreadsByThreadKey)) {
    const phase = draft.pendingEnvironmentSend?.phase;
    if (phase === "creating" || phase === "pairing" || phase === "loading-project") {
      void cloudSends.resume(draftId);
    }
  }
}
