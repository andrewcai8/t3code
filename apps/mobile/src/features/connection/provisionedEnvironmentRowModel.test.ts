import { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import {
  presentProvisionedEnvironment,
  provisionedEnvironmentRows,
} from "./provisionedEnvironmentRowModel";

const machine = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
  environmentId: "box-1",
  provider: "e2b",
  label: "proof/repo",
  repository: "proof/repo",
  projectDir: "/home/user/proof",
  threadId: "existing-thread",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
});

function connectedEnvironment(
  input: Omit<Partial<ConnectedEnvironmentSummary>, "environmentId"> & {
    readonly environmentId: string;
  },
): ConnectedEnvironmentSummary {
  return {
    environmentId: EnvironmentId.make(input.environmentId),
    environmentLabel: input.environmentLabel ?? input.environmentId,
    displayUrl: input.displayUrl ?? `https://${input.environmentId}.example.test/`,
    isRelayManaged: input.isRelayManaged ?? false,
    isEnabled: input.isEnabled ?? true,
    connectionState: input.connectionState ?? "connected",
    connectionError: input.connectionError ?? null,
    connectionErrorTraceId: input.connectionErrorTraceId ?? null,
  };
}

describe("provisionedEnvironmentRows", () => {
  it("pairs each machine with this device's record of it when one exists", () => {
    const joined = connectedEnvironment({ environmentId: "box-1" });
    const other = {
      ...machine,
      requestId: "22222222-2222-4222-a222-222222222222" as typeof machine.requestId,
      environmentId: EnvironmentId.make("box-2"),
    };

    expect(
      provisionedEnvironmentRows(
        [machine, other],
        [connectedEnvironment({ environmentId: "laptop" }), joined],
      ),
    ).toEqual([
      { environment: machine, joined },
      { environment: other, joined: null },
    ]);
  });
});

describe("presentProvisionedEnvironment", () => {
  const managerLabel = "Andrew's MacBook";

  it("offers Join for a machine this device has not joined", () => {
    expect(
      presentProvisionedEnvironment({
        row: { environment: machine, joined: null },
        join: { kind: "idle" },
        managerLabel,
        threadTitle: null,
      }),
    ).toEqual({
      title: "proof/repo",
      detail: "E2B · proof/repo",
      status: "Not joined",
      tone: "muted",
      action: "join",
    });
  });

  it("falls back to the project directory for a machine without a repository", () => {
    expect(
      presentProvisionedEnvironment({
        row: {
          environment: { ...machine, provider: "namespace", repository: null },
          joined: null,
        },
        join: { kind: "idle" },
        managerLabel,
        threadTitle: null,
      }).detail,
    ).toBe("Namespace · /home/user/proof");
  });

  it("shows the join in flight with no action to tap", () => {
    expect(
      presentProvisionedEnvironment({
        row: { environment: machine, joined: null },
        join: { kind: "joining" },
        managerLabel,
        threadTitle: null,
      }),
    ).toMatchObject({ status: "Joining…", tone: "muted", action: null });
  });

  it("says why a machine reachable only through the manager cannot be joined", () => {
    expect(
      presentProvisionedEnvironment({
        row: { environment: machine, joined: null },
        join: { kind: "unreachable" },
        managerLabel,
        threadTitle: null,
      }),
    ).toMatchObject({
      status: "Reachable only through Andrew's MacBook. Open it there instead.",
      tone: "muted",
      action: "join",
    });
  });

  it("surfaces a failed join as an error and lets the person try again", () => {
    expect(
      presentProvisionedEnvironment({
        row: { environment: machine, joined: null },
        join: { kind: "failed", message: "The lease has expired." },
        managerLabel,
        threadTitle: null,
      }),
    ).toMatchObject({ status: "The lease has expired.", tone: "danger", action: "join" });
  });

  it("offers Leave and the live connection state once joined, titled by its chat", () => {
    expect(
      presentProvisionedEnvironment({
        row: { environment: machine, joined: connectedEnvironment({ environmentId: "box-1" }) },
        join: { kind: "idle" },
        managerLabel,
        threadTitle: "Fix the flaky test",
      }),
    ).toEqual({
      title: "Fix the flaky test",
      detail: "E2B · proof/repo",
      status: "Joined · Connected",
      tone: "muted",
      action: "leave",
    });
  });

  it("keeps a joined machine's connection failure visible", () => {
    expect(
      presentProvisionedEnvironment({
        row: {
          environment: machine,
          joined: connectedEnvironment({
            environmentId: "box-1",
            connectionState: "error",
            connectionError: "Sandbox is not responding.",
          }),
        },
        join: { kind: "idle" },
        managerLabel,
        threadTitle: null,
      }),
    ).toMatchObject({
      status: "Joined · Connection failed. Reason: Sandbox is not responding.",
      tone: "danger",
      action: "leave",
    });
  });

  it("shows a joined machine that was switched off as Off, not as broken", () => {
    expect(
      presentProvisionedEnvironment({
        row: {
          environment: machine,
          joined: connectedEnvironment({
            environmentId: "box-1",
            isEnabled: false,
            connectionState: "error",
            connectionError: "Stale error from before it was switched off.",
          }),
        },
        join: { kind: "idle" },
        managerLabel,
        threadTitle: null,
      }),
    ).toMatchObject({ status: "Joined · Off", tone: "muted", action: "leave" });
  });
});
