import type { ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { SupervisorConnectionState } from "./model.ts";
import type { EnvironmentShellStatus } from "../state/shell.ts";
import type { EnvironmentThreadStatus } from "../state/threadState.ts";

export type ActivityAvailability =
  | { readonly kind: "live" }
  | { readonly kind: "synchronizing" }
  | { readonly kind: "unavailable"; readonly label: string };

export const LIVE_ACTIVITY_AVAILABILITY: ActivityAvailability = { kind: "live" };
const SYNC_FAILED_ACTIVITY: ActivityAvailability = { kind: "unavailable", label: "Sync failed" };
const SYNCHRONIZING_ACTIVITY: ActivityAvailability = { kind: "synchronizing" };
const UNAVAILABLE_ACTIVITY = {
  available: { kind: "unavailable", label: "Disconnected" },
  offline: { kind: "unavailable", label: "Offline" },
  connecting: { kind: "unavailable", label: "Connecting" },
  reconnecting: { kind: "unavailable", label: "Reconnecting" },
  error: { kind: "unavailable", label: "Connection failed" },
} satisfies Record<Exclude<EnvironmentConnectionPhase, "connected">, ActivityAvailability>;

/** Live activity requires the connection and the snapshots used by its view to be current. */
export function deriveActivityAvailability(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly shellStatus: EnvironmentShellStatus;
  readonly threadStatus?: EnvironmentThreadStatus;
  readonly syncFailed?: boolean;
}): ActivityAvailability {
  if (input.connectionPhase !== "connected") return UNAVAILABLE_ACTIVITY[input.connectionPhase];
  if (input.syncFailed) return SYNC_FAILED_ACTIVITY;
  if (
    input.shellStatus !== "live" ||
    (input.threadStatus !== undefined && input.threadStatus !== "live")
  ) {
    return SYNCHRONIZING_ACTIVITY;
  }
  return LIVE_ACTIVITY_AVAILABILITY;
}

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

export interface EnvironmentConnectionPresentation {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null };
    case "offline":
      return { phase: "offline", error: null, traceId: null };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
    case "blocked":
      return {
        phase: "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
      };
  }
}

export function connectionStatusText(connection: EnvironmentConnectionPresentation): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      return connection.error
        ? `Failed to connect. Reconnecting... Reason: ${connection.error}`
        : "Reconnecting...";
    case "connected":
      return "Connected";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: EnvironmentConnectionPresentation): string {
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}
