import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/automations")({
  beforeLoad: () => {
    throw redirect({ to: "/automations", replace: true });
  },
});
