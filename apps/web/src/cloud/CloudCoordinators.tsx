import { useEffect } from "react";

import { ThreadLifecycleOverlayCoordinator } from "../components/ThreadLifecycleOverlayCoordinator";
import { CloudBoxes } from "./CloudBoxes";
import { resumeCloudSends } from "./cloudSends";
import { ProvisionCancellations } from "./ProvisionCancellations";

/**
 * The app-wide cloud machine work: cloud sends a reload cut off, cancelled provisions to dispose,
 * the boxes the connected hosts report, and thread lifecycle changes made while a machine was
 * offline.
 */
export function CloudCoordinators({ authenticated }: { authenticated: boolean }) {
  useEffect(() => {
    if (authenticated) resumeCloudSends();
  }, [authenticated]);
  return (
    <>
      <ProvisionCancellations />
      <CloudBoxes />
      <ThreadLifecycleOverlayCoordinator />
    </>
  );
}
