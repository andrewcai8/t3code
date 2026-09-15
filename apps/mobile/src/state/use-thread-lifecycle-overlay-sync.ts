import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  isOfflineThreadLifecycleDispatchResult,
  isThreadLifecycleOfflineFailure,
  persistThreadLifecycleOverlays,
  planThreadLifecycleOverlaySync,
  replaceThreadLifecycleOverlays,
  setThreadLifecycleOverlay,
  threadLifecycleOverlayAtom,
} from "@t3tools/client-runtime/state/threads";
import { useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom } from "./server";
import { environmentSnapshotAtom } from "./shell";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";

/** Persist local settle/un-settle and flush those commands once the environment reconnects. */
export function useThreadLifecycleOverlaySync() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const flushedKeys = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const overlays = appAtomRegistry.get(threadLifecycleOverlayAtom);
      persistThreadLifecycleOverlays(overlays);
      const configs = appAtomRegistry.get(environmentServerConfigsAtom);
      const planned = planThreadLifecycleOverlaySync({
        overlays,
        environments: [...enabledEnvironmentIds(catalog)].map((environmentId) => ({
          environmentId,
          live:
            appAtomRegistry.get(environmentPresentations.presentationAtom(environmentId))
              ?.connection.phase === "connected",
          capabilities: configs.get(environmentId)?.environment.capabilities,
          snapshot: appAtomRegistry.get(environmentSnapshotAtom(environmentId)),
        })),
      });
      replaceThreadLifecycleOverlays(appAtomRegistry, planned.overlays);
      persistThreadLifecycleOverlays(planned.overlays);
      for (const key of [...flushedKeys.current]) {
        if (!planned.overlays.has(key)) flushedKeys.current.delete(key);
      }
      for (const job of planned.jobs) {
        const key = threadKey(job);
        if (inFlight.current.has(key) || flushedKeys.current.has(key)) continue;
        inFlight.current.add(key);
        flushedKeys.current.add(key);
        void (
          job.kind === "settled"
            ? settle({
                environmentId: job.environmentId,
                input: { threadId: job.threadId },
              })
            : unsettle({
                environmentId: job.environmentId,
                input: { threadId: job.threadId, reason: "user" },
              })
        )
          .then((result) => {
            if (result._tag === "Failure") {
              flushedKeys.current.delete(key);
              if (!isThreadLifecycleOfflineFailure(squashAtomCommandFailure(result))) {
                setThreadLifecycleOverlay(appAtomRegistry, job, undefined);
              }
              return;
            }
            if (isOfflineThreadLifecycleDispatchResult(result.value)) {
              flushedKeys.current.delete(key);
            }
          })
          .finally(() => {
            inFlight.current.delete(key);
          });
      }
    };
    const unsubscribers = [
      appAtomRegistry.subscribe(threadLifecycleOverlayAtom, sync),
      appAtomRegistry.subscribe(environmentServerConfigsAtom, sync),
    ];
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      unsubscribers.push(
        appAtomRegistry.subscribe(environmentSnapshotAtom(environmentId), sync),
        appAtomRegistry.subscribe(environmentPresentations.presentationAtom(environmentId), sync),
      );
    }
    sync();
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [catalog, settle, unsettle]);
}
