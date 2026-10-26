import { connectionBox } from "@t3tools/client-runtime/connection";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentSession } from "../state/session";
import { toastManager } from "./ui/toast";

interface LegacyPermissionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Environments whose settled session still carries pre-scope permissions. A cloud chat's machine
 * is left out: it pairs again by itself when its grant is the old one.
 */
const legacyPermissionEnvironmentsAtom = Atom.make((get) =>
  get(environmentSummaries.identitiesAtom).filter(({ environmentId }) => {
    const entry = get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
    if (entry !== undefined && connectionBox(entry.target) !== null) return false;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return (
      session._tag === "Success" && !session.waiting && sessionHasLegacyPermissions(session.value)
    );
  }),
).pipe(Atom.withLabel("web-legacy-permission-environments"));

const dismissalKey = (environmentId: EnvironmentId) =>
  `t3code:permission-update:v1:${environmentId}`;

function showPermissionNotice(
  router: AnyRouter,
  { environmentId, label }: LegacyPermissionEnvironment,
) {
  const key = dismissalKey(environmentId);
  const persistDismissal = () => {
    try {
      setLocalStorageItem(key, true, Schema.Boolean);
    } catch {}
  };
  const dismiss = () => {
    persistDismissal();
    toastManager.close(id);
  };
  const id = toastManager.add({
    title: `Permissions have changed for ${label}`,
    description:
      "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
    timeout: 0,
    onClose: persistDismissal,
    actionProps: {
      children: "Open Connections",
      onClick: () => {
        dismiss();
        void router.navigate({ to: "/settings/connections" });
      },
    },
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: { children: "Dismiss", onClick: dismiss },
      secondaryActionVariant: "ghost",
    },
  });
}

/** Asks once per environment, until dismissed, to re-pair a connection that predates scoped permissions. */
export function startPermissionUpdateNotices(router: AnyRouter): () => void {
  const shown = new Set<EnvironmentId>();
  return appAtomRegistry.subscribe(
    legacyPermissionEnvironmentsAtom,
    (environments) => {
      for (const environment of environments) {
        if (shown.has(environment.environmentId)) continue;
        try {
          if (getLocalStorageItem(dismissalKey(environment.environmentId), Schema.Boolean))
            continue;
        } catch {}
        shown.add(environment.environmentId);
        showPermissionNotice(router, environment);
      }
    },
    { immediate: true },
  );
}
