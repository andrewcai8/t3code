import { useEffect } from "react";

import { ThreadLifecycleOverlayCoordinator } from "../components/ThreadLifecycleOverlayCoordinator";
import { resumeCloudSends } from "./cloudSends";

/**
 * Route-scoped cloud machine work: cloud sends a reload cut off, and thread lifecycle changes made
 * while a machine was offline. Box sync and cancelled provisions live in `AppRoot` so they survive
 * the pairing and welcome routes.
 */
export function CloudCoordinators({ authenticated }: { authenticated: boolean }) {
  useEffect(() => {
    if (authenticated) resumeCloudSends();
  }, [authenticated]);
  return <ThreadLifecycleOverlayCoordinator />;
}
