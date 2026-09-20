import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { DiscoveredProvisionedEnvironment } from "@t3tools/contracts";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

export type ProvisionedJoinState =
  | { readonly kind: "idle" }
  | { readonly kind: "joining" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "failed"; readonly message: string };

export interface ProvisionedEnvironmentRow {
  readonly environment: DiscoveredProvisionedEnvironment;
  /** This device's own record of the machine once joined; null until then. */
  readonly joined: ConnectedEnvironmentSummary | null;
}

export function provisionedEnvironmentRows(
  provisioned: ReadonlyArray<DiscoveredProvisionedEnvironment>,
  connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>,
): ReadonlyArray<ProvisionedEnvironmentRow> {
  return provisioned.map((environment) => ({
    environment,
    joined:
      connectedEnvironments.find(
        (candidate) => candidate.environmentId === environment.environmentId,
      ) ?? null,
  }));
}

export interface ProvisionedEnvironmentPresentation {
  readonly title: string;
  readonly detail: string;
  readonly status: string;
  readonly tone: "muted" | "danger";
  /** Null while a join is in flight. */
  readonly action: "join" | "leave" | null;
}

const PROVIDER_LABELS = { e2b: "E2B", namespace: "Namespace" } as const;

export function presentProvisionedEnvironment(input: {
  readonly row: ProvisionedEnvironmentRow;
  readonly join: ProvisionedJoinState;
  readonly managerLabel: string;
  readonly threadTitle: string | null;
}): ProvisionedEnvironmentPresentation {
  const { environment, joined } = input.row;
  const title = input.threadTitle ?? environment.label;
  const detail = `${PROVIDER_LABELS[environment.provider]} · ${environment.repository ?? environment.projectDir}`;
  if (joined !== null) {
    const connection = joined.isEnabled
      ? connectionStatusText({
          phase: joined.connectionState,
          error: joined.connectionError,
          traceId: joined.connectionErrorTraceId,
        })
      : "Off";
    return {
      title,
      detail,
      status: `Joined · ${connection}`,
      tone: joined.isEnabled && joined.connectionError !== null ? "danger" : "muted",
      action: "leave",
    };
  }
  switch (input.join.kind) {
    case "joining":
      return { title, detail, status: "Joining…", tone: "muted", action: null };
    case "unreachable":
      return {
        title,
        detail,
        status: `Reachable only through ${input.managerLabel}. Open it there instead.`,
        tone: "muted",
        action: "join",
      };
    case "failed":
      return { title, detail, status: input.join.message, tone: "danger", action: "join" };
    case "idle":
      return { title, detail, status: "Not joined", tone: "muted", action: "join" };
  }
}
