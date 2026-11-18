import type { ContextMenuItem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

/** The thread menu entry that stops a thread's cloud machine for good. */
export function stopProvisionedCloudMachineMenuItem(
  resolve: MessageResolver = m,
): ContextMenuItem<"stop-cloud-machine"> {
  return {
    id: "stop-cloud-machine",
    label: resolve(msg("Stop cloud machine")),
    icon: "cloud",
    destructive: true,
    separatorBefore: true,
  };
}
