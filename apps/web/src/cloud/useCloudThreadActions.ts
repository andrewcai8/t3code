import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import {
  isOfflineThreadLifecycleDispatchResult,
  setThreadLifecycleOverlay,
  threadLifecycleOverlayAtom,
} from "@t3tools/client-runtime/state/threads";
import type {
  EnvironmentProvisionDisposeResult,
  EnvironmentProvisionPauseResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell } from "../state/entities";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { forgetProvisionedSandbox, provisionedSandboxFor } from "./provisionedSandboxLeases";

type DisposeOutcome = { readonly kind: "absent" } | EnvironmentProvisionDisposeResult;
type PauseOutcome = { readonly kind: "absent" } | EnvironmentProvisionPauseResult;

/**
 * A thread's cloud machine through the thread's own actions: archive pauses it, delete releases
 * it, and the thread menu can stop it. A delete on a machine that is offline only hides the thread
 * here and replays when the machine reconnects.
 */
export function useCloudThreadActions() {
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const disposeProvisionedEnvironment = useAtomCommand(
    serverEnvironment.disposeProvisionedEnvironment,
    { reportFailure: false },
  );
  const pauseProvisionedEnvironment = useAtomCommand(
    serverEnvironment.pauseProvisionedEnvironment,
    { reportFailure: false },
  );

  const disposeBox = useCallback(
    async (target: ScopedThreadRef) => {
      const lease = provisionedSandboxFor(target);
      if (!lease) return AsyncResult.success<DisposeOutcome>({ kind: "absent" });
      const result = await disposeProvisionedEnvironment({
        environmentId: lease.managerEnvironmentId,
        input: { leaseId: lease.leaseId, sandboxId: lease.sandboxId },
      });
      if (result._tag === "Success" && result.value.kind === "disposed") {
        forgetProvisionedSandbox(target);
      }
      return result;
    },
    [disposeProvisionedEnvironment],
  );

  /** Pauses an archived thread's cloud machine, which then stops billing for compute. */
  const pauseBox = useCallback(
    async (target: ScopedThreadRef) => {
      const lease = provisionedSandboxFor(target);
      if (!lease) return AsyncResult.success<PauseOutcome>({ kind: "absent" });
      const result = await pauseProvisionedEnvironment({
        environmentId: lease.managerEnvironmentId,
        input: { leaseId: lease.leaseId, sandboxId: lease.sandboxId },
      });
      if (result._tag === "Success" && result.value.kind === "refused") {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Cloud workspace remains running",
            description: result.value.message,
          }),
        );
      } else if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Could not pause cloud workspace",
            description: "Retry when the cloud manager is reachable.",
          }),
        );
      }
      return result;
    },
    [pauseProvisionedEnvironment],
  );

  const releaseBoxAfterDelete = useCallback(
    async (target: ScopedThreadRef) => {
      const result = await disposeBox(target);
      if (result._tag === "Success") {
        const value = result.value;
        if (value.kind === "absent" || value.kind === "disposed") return;
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Thread deleted, but its cloud machine is still running.",
            description: value.message,
          }),
        );
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Thread deleted, but its cloud machine is still running.",
            description: "Retry deleting the thread after the cloud manager is reachable.",
          }),
        );
      }
    },
    [disposeBox],
  );

  /**
   * What a thread delete reads before it runs: whether the thread's machine is connected, and
   * the step to take once the delete dispatch returns.
   */
  const beginDelete = useCallback(
    (target: ScopedThreadRef) => {
      const connection = appAtomRegistry.get(
        environmentPresentations.presentationAtom(target.environmentId),
      )?.connection;
      const workspaceMissing = connection?.blockedReason === "workspace-missing";
      const pendingOverlay = appAtomRegistry.get(threadLifecycleOverlayAtom).get(threadKey(target));
      return {
        connected: connection?.phase === "connected",
        /**
         * After a delete dispatch succeeds: an offline delete only hides the thread here, with
         * Undo, and a machine that is gone for good can release its lease now. Any other delete
         * releases the thread's cloud machine.
         */
        afterDelete: async (dispatched: unknown, threadRef: ScopedThreadRef) => {
          if (!isOfflineThreadLifecycleDispatchResult(dispatched)) {
            await releaseBoxAfterDelete(threadRef);
            return;
          }
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Deleted on this device",
              description: "It will be removed from the machine if it reconnects.",
              actionProps: {
                children: "Undo",
                onClick: () => setThreadLifecycleOverlay(appAtomRegistry, target, pendingOverlay),
              },
            }),
          );
          if (workspaceMissing) await releaseBoxAfterDelete(target);
        },
      };
    },
    [releaseBoxAfterDelete],
  );

  /** An unsettle wakes the thread's machine first, unless it only undoes a settle made here. */
  const wakeForUnsettle = useCallback(
    async (target: ScopedThreadRef) => {
      const pendingLocalSettle =
        appAtomRegistry.get(threadLifecycleOverlayAtom).get(threadKey(target))?.kind === "settled";
      if (!pendingLocalSettle) await retryEnvironment(target.environmentId);
    },
    [retryEnvironment],
  );

  const stopProvisionedCloudMachine = useCallback(
    async (target: ScopedThreadRef) => {
      const lease = provisionedSandboxFor(target);
      if (!lease) return;
      const api = readLocalApi();
      if (!api) return;
      const thread = readThreadShell(target);
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            `Stop the cloud machine for "${thread?.title ?? "this thread"}"?`,
            "This permanently stops the cloud machine and ends any running work.",
            "The thread and conversation will remain.",
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure") {
        const error = squashAtomCommandFailure(confirmed);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm cloud machine stop",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      if (!confirmed.value) return;

      const result = await disposeBox(target);
      if (result._tag === "Success" && result.value.kind === "absent") return;
      if (result._tag === "Success" && result.value.kind === "disposed") {
        toastManager.add({
          type: "success",
          title: "Cloud machine stopped",
          description: "The thread remains, but its cloud workspace has been released.",
        });
        return;
      }
      const description =
        result._tag === "Success" && result.value.kind === "refused"
          ? result.value.message
          : "Retry after the cloud manager is reachable.";
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Could not stop cloud machine",
          description,
        }),
      );
    },
    [disposeBox],
  );

  return useMemo(
    () => ({ pauseBox, beginDelete, wakeForUnsettle, stopProvisionedCloudMachine }),
    [beginDelete, pauseBox, stopProvisionedCloudMachine, wakeForUnsettle],
  );
}
