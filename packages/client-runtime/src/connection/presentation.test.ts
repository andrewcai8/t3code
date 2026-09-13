import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  connectionStatusText,
  connectionStatusTitle,
  deriveActivityAvailability,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

describe("activity availability", () => {
  it.each([
    ["available", "Disconnected"],
    ["offline", "Offline"],
    ["connecting", "Connecting"],
    ["reconnecting", "Reconnecting"],
    ["error", "Connection failed"],
  ] as const)("does not report cached work as live while %s", (connectionPhase, label) => {
    expect(
      deriveActivityAvailability({ connectionPhase, shellStatus: "live", threadStatus: "live" }),
    ).toEqual({ kind: "unavailable", label });
  });

  it.each(["empty", "cached", "synchronizing"] as const)(
    "waits for the %s shell even after the socket and detail reconnect",
    (shellStatus) => {
      expect(
        deriveActivityAvailability({
          connectionPhase: "connected",
          shellStatus,
          threadStatus: "live",
        }),
      ).toEqual({ kind: "synchronizing" });
    },
  );

  it.each(["empty", "cached", "synchronizing"] as const)(
    "waits for %s detail in an open chat",
    (threadStatus) => {
      expect(
        deriveActivityAvailability({
          connectionPhase: "connected",
          shellStatus: "live",
          threadStatus,
        }),
      ).toEqual({ kind: "synchronizing" });
    },
  );

  it("restores live activity only after the data used by that view synchronizes", () => {
    expect(
      deriveActivityAvailability({ connectionPhase: "connected", shellStatus: "live" }),
    ).toEqual({ kind: "live" });
    expect(
      deriveActivityAvailability({
        connectionPhase: "connected",
        shellStatus: "live",
        threadStatus: "live",
      }),
    ).toEqual({ kind: "live" });
  });

  it("keeps a failed thread unavailable through reconnect until its replacement synchronizes", () => {
    const states = [
      { connectionPhase: "connected", threadStatus: "cached", syncFailed: true },
      { connectionPhase: "reconnecting", threadStatus: "cached", syncFailed: true },
      { connectionPhase: "connected", threadStatus: "cached", syncFailed: true },
      { connectionPhase: "connected", threadStatus: "synchronizing", syncFailed: false },
      { connectionPhase: "connected", threadStatus: "live", syncFailed: false },
    ] as const;
    expect(
      states.map((state) => deriveActivityAvailability({ ...state, shellStatus: "live" })),
    ).toEqual([
      { kind: "unavailable", label: "Sync failed" },
      { kind: "unavailable", label: "Reconnecting" },
      { kind: "unavailable", label: "Sync failed" },
      { kind: "synchronizing" },
      { kind: "live" },
    ]);
  });
});

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
    });
  });

  it("combines reconnect progress with the latest failure", () => {
    const connection = {
      phase: "reconnecting",
      error: "Relay request timed out.",
      traceId: "trace-retry",
    } as const;
    expect(connectionStatusText(connection)).toBe(
      "Failed to connect. Reconnecting... Reason: Relay request timed out.",
    );
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
    });
  });
});

it("distinguishes a failed data stream from synchronization and prioritizes disconnect", () => {
  expect(
    deriveActivityAvailability({
      connectionPhase: "connected",
      shellStatus: "cached",
      syncFailed: true,
    }),
  ).toEqual({ kind: "unavailable", label: "Sync failed" });
  expect(
    deriveActivityAvailability({
      connectionPhase: "reconnecting",
      shellStatus: "cached",
      syncFailed: true,
    }),
  ).toEqual({ kind: "unavailable", label: "Reconnecting" });
});
