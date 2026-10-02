import { describeCloudCleanup } from "@t3tools/client-runtime/cloud";
import type { DiscoveredProvisionedEnvironment } from "@t3tools/contracts";

/** What a row is doing on the user's behalf. */
export type ProvisionedRowAction =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly label: string }
  | { readonly kind: "failed"; readonly message: string };

export interface ProvisionedEnvironmentPresentation {
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly tone: "muted" | "danger";
  /** Keep a machine scheduled for removal, or allow cleanup of one the user kept. */
  readonly cleanupAction: "keep" | "allow" | null;
}

const PROVIDER_LABELS = { e2b: "E2B", namespace: "Namespace" } as const;
const LIFECYCLE_LABELS: Record<DiscoveredProvisionedEnvironment["lifecycle"], string> = {
  active: "Running",
  paused: "Paused",
  missing: "Lost",
  disposed: "Deleted",
};

/** A cloud machine as its row shows it: named for its chat when the chat is on this device. */
export function presentProvisionedEnvironment(input: {
  readonly environment: DiscoveredProvisionedEnvironment;
  readonly threadTitle: string | null;
  readonly action: ProvisionedRowAction;
  readonly now: number;
}): ProvisionedEnvironmentPresentation {
  const { environment, action } = input;
  const cleanup = describeCloudCleanup(environment.cleanup, input.now);
  return {
    title: input.threadTitle ?? environment.label,
    detail: `${PROVIDER_LABELS[environment.provider]} · ${environment.repository ?? environment.projectDir}`,
    status:
      action.kind === "working"
        ? action.label
        : action.kind === "failed"
          ? action.message
          : cleanup
            ? `${LIFECYCLE_LABELS[environment.lifecycle]} · ${cleanup.text}`
            : LIFECYCLE_LABELS[environment.lifecycle],
    tone: action.kind === "failed" ? "danger" : "muted",
    cleanupAction: cleanup?.action ?? null,
  };
}
