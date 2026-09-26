import { createFileRoute } from "@tanstack/react-router";

import { AutomationsSettings } from "../components/settings/AutomationsSettings";

export const Route = createFileRoute("/settings/automations")({
  component: AutomationsSettings,
});
