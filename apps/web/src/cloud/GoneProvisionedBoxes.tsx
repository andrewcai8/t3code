import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { environmentCatalog } from "../connection/catalog";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { useAutomationHosts } from "./automationHosts";

/**
 * Marks the saved cloud boxes their hosts report lost or disposed as missing, so none keeps
 * reconnecting or is offered for a new chat. A box disposed elsewhere is only known to its host.
 */
export function GoneProvisionedBoxes() {
  const hosts = useAutomationHosts();
  const hostIds = useMemo(() => hosts.map((host) => host.environmentId), [hosts]);
  const { boxes } = useAtomValue(serverEnvironment.provisionedBoxes(hostIds));
  const markGone = useAtomCommand(environmentCatalog.markGoneWorkspacesMissing);
  useEffect(() => {
    void markGone(boxes);
  }, [boxes, markGone]);
  return null;
}
