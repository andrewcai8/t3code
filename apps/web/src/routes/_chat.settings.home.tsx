import { createFileRoute } from "@tanstack/react-router";

import { HomeSettings } from "../components/settings/HomeSettings";

function SettingsHomeRoute() {
  return <HomeSettings />;
}

export const Route = createFileRoute("/_chat/settings/home")({
  component: SettingsHomeRoute,
});
