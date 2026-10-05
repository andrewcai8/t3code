import { useAtomValue } from "@effect/atom-react";
import {
  BOX_STATUS_NAME,
  type CloudMachine,
  cloudMachineStatus,
  cloudWakeNotice,
  connectionBox,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/unstable/reactivity";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";

function OpenConnectionsButton() {
  const navigate = useNavigate();
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => void navigate({ to: "/settings/connections" })}
    >
      Connections
    </Button>
  );
}

const NO_MACHINE = Atom.make((): CloudMachine | null => null).pipe(
  Atom.withLabel("web-cloud-machine:none"),
);

/** A cloud chat's machine while it is asleep, waking or updating, as its host last said. */
export function useCloudMachine(environmentId: EnvironmentId | null): CloudMachine | null {
  return useAtomValue(
    environmentId === null ? NO_MACHINE : environmentCatalog.cloudMachineAtom(environmentId),
  );
}

/**
 * What the composer's "unavailable" banner says for a cloud machine: one removed for good, one
 * waking or updating with the time its machine really takes, or a box named by its role, since
 * its saved label names the machine it first ran on. Empty for any other environment.
 */
export function cloudUnavailableBanner(
  state: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  },
  reconnecting: boolean,
  machine: CloudMachine | null,
): Partial<Pick<ComposerBannerStackItem, "title" | "description" | "actions">> {
  const target = appAtomRegistry
    .get(environmentCatalog.catalogValueAtom)
    .entries.get(state.environmentId)?.target;
  const isBox = target !== undefined && connectionBox(target) !== null;
  const name = isBox
    ? BOX_STATUS_NAME.charAt(0).toUpperCase() + BOX_STATUS_NAME.slice(1)
    : state.label;
  if (state.connection.blockedReason === "workspace-missing") {
    return {
      title: `${name} is no longer available`,
      description: "This chat's cloud machine was removed. Its saved history stays readable here.",
      actions: <OpenConnectionsButton />,
    };
  }
  const status = isBox ? cloudMachineStatus(machine ?? undefined, state.connection.phase) : null;
  if (status === "waking" || status === "updating") {
    const { title, description } = cloudWakeNotice(status, machine?.machine);
    return { title, description };
  }
  return isBox ? { title: `${name} is ${reconnecting ? "reconnecting" : "offline"}` } : {};
}
