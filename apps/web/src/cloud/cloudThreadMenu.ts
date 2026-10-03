import type { ContextMenuItem } from "@t3tools/contracts";

/** The thread menu entry that stops a thread's cloud machine for good. */
export function stopProvisionedCloudMachineMenuItem(): ContextMenuItem<"stop-cloud-machine"> {
  return {
    id: "stop-cloud-machine",
    label: "Stop cloud machine",
    icon: "cloud",
    destructive: true,
    separatorBefore: true,
  };
}
