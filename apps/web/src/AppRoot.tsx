import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { HomeFleetHost } from "./components/home/HomeFleetHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { CloudBoxes } from "./cloud/CloudBoxes";
import { ProvisionCancellations } from "./cloud/ProvisionCancellations";
import { I18nProvider } from "./i18n/I18nProvider";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <I18nProvider>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
        <ProvisionCancellations />
        <CloudBoxes />
        <HomeFleetHost />
        <ElectronBrowserHost />
        <QuitHoldOverlay />
      </AppAtomRegistryProvider>
    </I18nProvider>
  );
}
