import {
  BOX_STATUS_NAME,
  connectionBox,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

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

/**
 * What the composer's "unavailable" banner says for a cloud machine: one removed for good, one
 * waking from sleep, or a box named by its role, since its saved label names the machine it
 * first ran on. Empty for any other environment.
 */
export function cloudUnavailableBanner(
  state: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  },
  reconnecting: boolean,
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
  if (state.connection.phase === "waking") {
    return {
      title: `${name} is waking up...`,
      description: "This can take a few minutes. It reconnects on its own.",
    };
  }
  return isBox ? { title: `${name} is ${reconnecting ? "reconnecting" : "offline"}` } : {};
}
