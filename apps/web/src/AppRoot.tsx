import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { HomeFleetHost } from "./components/home/HomeFleetHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { CloudBoxes } from "./cloud/CloudBoxes";
import { ProvisionCancellations } from "./cloud/ProvisionCancellations";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <ProvisionCancellations />
      <CloudBoxes />
      <HomeFleetHost />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}
