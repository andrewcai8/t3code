import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionStatusName,
  connectionStatusText,
  connectionStatusTitle,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

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

describe("cloud box connection presentation", () => {
  it("names a cloud box by its role and anything else by its label", () => {
    const box = new BearerConnectionTarget({
      ...TARGET,
      label: "eme8vbl7bl7fe",
      box: { managerId: EnvironmentId.make("host") },
    });
    expect(connectionStatusName(box)).toBe("this chat's cloud machine");
    expect(connectionStatusName(TARGET)).toBe("Remote environment");
  });

  it("says a box whose host is resuming it is waking up, not failing", () => {
    const connection = presentConnectionState(
      supervisorState({
        phase: "waking",
        stage: null,
        lastFailure: new ConnectionTransientError({
          reason: "not-serving",
          detail:
            "Remote environment endpoint https://box.example.test/ returned undeclared status 502.",
        }),
      }),
    );

    expect(connection).toEqual({ phase: "waking", error: null, traceId: null });
    expect(connectionStatusText(connection)).toBe("Waking up...");
  });

  it.each(["available", "offline", "connected"] as const)(
    "keeps a persisted missing workspace removed while the supervisor is %s",
    (phase) => {
      const connection = presentEnvironmentConnection(
        supervisorState({ phase, network: "offline" }),
        new BearerConnectionTarget({ ...TARGET, workspaceStatus: "missing" }),
      );
      expect(connection).toEqual({
        phase: "error",
        error: "This workspace no longer exists. Its saved conversation is still available.",
        traceId: null,
        blockedReason: "workspace-missing",
      });
      expect(connectionStatusTitle(connection)).toBe("Machine removed");
    },
  );

  it("exposes a missing workspace as a terminal error", () => {
    const connection = presentConnectionState(
      supervisorState({
        phase: "blocked",
        stage: null,
        lastFailure: new ConnectionBlockedError({
          reason: "workspace-missing",
          detail: "This workspace no longer exists.",
        }),
      }),
    );
    expect(connection).toEqual({
      phase: "error",
      error: "This workspace no longer exists.",
      traceId: null,
      blockedReason: "workspace-missing",
    });
    expect(connectionStatusText(connection)).toBe("Machine removed");
    expect(connectionStatusTitle(connection)).toBe("Machine removed");
  });
});
