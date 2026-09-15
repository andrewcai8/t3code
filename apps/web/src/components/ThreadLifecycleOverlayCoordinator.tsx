import { RegistryContext, useAtomValue } from "@effect/atom-react";
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
import { useContext, useEffect, useRef } from "react";

import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentSnapshotAtom } from "../state/shell";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/** Persist local settle/un-settle and flush those commands once the environment reconnects. */
export function ThreadLifecycleOverlayCoordinator() {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const settle = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettle = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const flushedKeys = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    const sync = () => {
      if (cancelled) return;
      const overlays = registry.get(threadLifecycleOverlayAtom);
      persistThreadLifecycleOverlays(overlays);
      const configs = registry.get(environmentServerConfigsAtom);
      const planned = planThreadLifecycleOverlaySync({
        overlays,
        environments: [...enabledEnvironmentIds(catalog)].map((environmentId) => ({
          environmentId,
          live:
            registry.get(environmentPresentations.presentationAtom(environmentId))?.connection
              .phase === "connected",
          capabilities: configs.get(environmentId)?.environment.capabilities,
          snapshot: registry.get(environmentSnapshotAtom(environmentId)),
        })),
      });
      replaceThreadLifecycleOverlays(registry, planned.overlays);
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
                setThreadLifecycleOverlay(registry, job, undefined);
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
      registry.subscribe(threadLifecycleOverlayAtom, sync),
      registry.subscribe(environmentServerConfigsAtom, sync),
    ];
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      unsubscribers.push(
        registry.subscribe(environmentSnapshotAtom(environmentId), sync),
        registry.subscribe(environmentPresentations.presentationAtom(environmentId), sync),
      );
    }
    sync();
    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [catalog, registry, settle, unsettle]);

  return null;
}
