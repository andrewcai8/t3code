import { useAtomValue } from "@effect/atom-react";
import { describeRestorable } from "@t3tools/client-runtime/cloud";
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
import { Atom } from "effect/reactivity";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { useNowMinute } from "../hooks/useNowMinute";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

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

/** A removed box's host row while its host can still restore it; null otherwise. */
function useRestorableBox(managerId: EnvironmentId, environmentId: EnvironmentId) {
  const boxes = useAtomValue(serverEnvironment.provisionedBoxes([managerId]));
  // The minute clock is UTC without its zone.
  const now = Date.parse(`${useNowMinute()}Z`);
  const box = boxes.find((candidate) => candidate.environmentId === environmentId);
  const text = describeRestorable(box?.restorableUntil, now);
  return box && text !== null ? { leaseId: box.leaseId, text } : null;
}

function RemovedMachineDescription(props: {
  readonly managerId: EnvironmentId;
  readonly environmentId: EnvironmentId;
}) {
  const restorable = useRestorableBox(props.managerId, props.environmentId);
  return restorable
    ? `This chat's cloud machine was removed. ${restorable.text}.`
    : "This chat's cloud machine was removed. Its saved history stays readable here.";
}

function RestoreMachineButton(props: {
  readonly managerId: EnvironmentId;
  readonly environmentId: EnvironmentId;
}) {
  const restorable = useRestorableBox(props.managerId, props.environmentId);
  const restore = useAtomCommand(serverEnvironment.restoreProvisionedEnvironment, {
    reportFailure: false,
  });
  if (!restorable) return null;
  const onRestore = async () => {
    const result = await restore({
      environmentId: props.managerId,
      input: { leaseId: restorable.leaseId },
    });
    if (result._tag === "Success" && result.value.kind === "restored") return;
    toastManager.add({
      type: "warning",
      title: "Could not restore this chat's cloud machine",
      description:
        result._tag === "Success" && result.value.kind === "refused"
          ? result.value.message
          : "Retry when the cloud manager is reachable.",
    });
  };
  return (
    <Button size="xs" variant="outline" onClick={() => void onRestore()}>
      Restore
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
 * What the composer's "unavailable" banner says for a cloud machine: one removed, with a way to
 * restore it while its host still can, one
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
  const box = target === undefined ? null : connectionBox(target);
  const isBox = box !== null;
  const name = isBox
    ? BOX_STATUS_NAME.charAt(0).toUpperCase() + BOX_STATUS_NAME.slice(1)
    : state.label;
  if (state.connection.blockedReason === "workspace-missing") {
    return box === null
      ? {
          title: `${name} is no longer available`,
          description:
            "This chat's cloud machine was removed. Its saved history stays readable here.",
          actions: <OpenConnectionsButton />,
        }
      : {
          title: `${name} is no longer available`,
          description: (
            <RemovedMachineDescription
              managerId={box.managerId}
              environmentId={state.environmentId}
            />
          ),
          actions: (
            <>
              <RestoreMachineButton managerId={box.managerId} environmentId={state.environmentId} />
              <OpenConnectionsButton />
            </>
          ),
        };
  }
  const status = isBox ? cloudMachineStatus(machine ?? undefined, state.connection.phase) : null;
  if (status === "waking" || status === "updating") {
    const { title, description } = cloudWakeNotice(status, machine?.machine);
    return { title, description };
  }
  return isBox ? { title: `${name} is ${reconnecting ? "reconnecting" : "offline"}` } : {};
}
