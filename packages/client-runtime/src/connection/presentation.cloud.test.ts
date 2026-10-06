import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  cloudMachineStatus,
  cloudWakeNotice,
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

describe("a cloud chat's machine", () => {
  it("reads awake while connected, follows this client's wake, and otherwise its host", () => {
    const asleep = { state: "asleep", machine: "sandbox" } as const;
    const updating = { state: "updating", machine: "sandbox" } as const;
    expect([
      cloudMachineStatus(asleep, "connected"),
      cloudMachineStatus(undefined, "waking"),
      cloudMachineStatus(asleep, "waking"),
      cloudMachineStatus(updating, "waking"),
      cloudMachineStatus(asleep, "available"),
      cloudMachineStatus(updating, "reconnecting"),
      cloudMachineStatus(undefined, "available"),
    ]).toEqual([null, "waking", "waking", "updating", "asleep", "updating", null]);
  });

  it("reads unavailable while its provider cannot start it, until this client connects", () => {
    const unplaced = {
      state: "asleep",
      machine: "sandbox",
      providerUnavailableAt: "2026-10-06T12:00:00.000Z",
    } as const;
    expect([
      cloudMachineStatus(unplaced, "reconnecting"),
      cloudMachineStatus({ ...unplaced, state: "waking" }, "waking"),
      cloudMachineStatus(unplaced, "connected"),
    ]).toEqual(["unavailable", "unavailable", null]);
  });

  it("says plainly that the provider could not start the machine, and when it last tried", () => {
    // @effect-diagnostics-next-line globalDate:off - a fixed local time.
    const at = new Date(2026, 9, 6, 14, 5);
    const lastTried = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const machine = (kind: "sandbox" | "mac") =>
      ({ state: "asleep", machine: kind, providerUnavailableAt: at.toISOString() }) as const;
    expect(cloudWakeNotice("unavailable", machine("sandbox"))).toEqual({
      title: "E2B couldn't start this chat's cloud machine yet",
      description: `The problem is on their side. Retrying on its own, last tried at ${lastTried}.`,
      eta: "retrying",
    });
    expect(cloudWakeNotice("unavailable", machine("mac")).title).toBe(
      "Namespace couldn't start this chat's cloud machine yet",
    );
  });

  it("says how long the machine it runs on takes to wake", () => {
    const on = (machine: "sandbox" | "mac") => ({ state: "asleep", machine }) as const;
    expect(cloudWakeNotice("waking", on("sandbox"))).toEqual({
      title: "This chat's cloud machine is waking up",
      description: "This usually takes about 10 seconds.",
      eta: "about 10 seconds",
    });
    expect(cloudWakeNotice("waking", on("mac"))).toEqual({
      title: "Restoring this chat's Mac",
      description: "This takes about 2 minutes. It reconnects on its own.",
      eta: "about 2 minutes",
    });
    expect(cloudWakeNotice("updating", on("mac")).title).toBe(
      "This chat's cloud machine is updating",
    );
    expect(cloudWakeNotice("waking", undefined).description).toBe("It reconnects on its own.");
  });
});
