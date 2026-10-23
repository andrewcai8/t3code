import { useAtomValue } from "@effect/atom-react";
import { selectLimitPresentations } from "@t3tools/client-runtime/state/presentation";
import { Atom } from "effect/reactivity";
import * as Linking from "expo-linking";
import { useEffect } from "react";
import { Platform } from "react-native";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "../state/presentation";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { useSubscriptionUsage } from "./useSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { createWidgetTheme } from "./widgetTheme";

// Isolate quota changes from the much busier thread/config presentation stream. Null means no
// environment is live: the widget keeps its last snapshot, which expires on its own, instead of
// being blanked or fed hours-old per-machine readings.
const snapshotAtom = Atom.make((get) => {
  const live = selectLimitPresentations(
    get(environmentPresentations.presentationsWithProvidersAtom),
    null,
  );
  if (live.size === 0) return null;
  return buildSubscriptionUsageSnapshot(
    live,
    Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
    Platform.OS === "android" ? Infinity : 6,
  );
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

export function SubscriptionUsageCoordinator() {
  const {
    themeMode,
    themeAppearance,
    themeVariablesByAppearance,
    isReady: appearanceReady,
  } = useAppearancePreferences();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const snapshot = useAtomValue(snapshotAtom);
  useSubscriptionUsage(catalog.isReady);
  const androidAppearance = Platform.OS === "android" ? themeAppearance : null;
  useEffect(() => {
    if (!catalog.isReady || !appearanceReady || snapshot === null) return;
    void Promise.resolve()
      .then(() =>
        publishSubscriptionUsage({
          ...snapshot,
          theme: createWidgetTheme(themeMode, themeVariablesByAppearance),
        }),
      )
      .catch((error: unknown) => {
        console.warn("Could not update subscription usage widget", error);
      });
  }, [
    catalog.isReady,
    appearanceReady,
    snapshot,
    themeMode,
    themeVariablesByAppearance,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Android stores resolved colors; System appearance changes must republish them.
    androidAppearance,
  ]);
  return null;
}
