import { EnvironmentId } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  upgradeThroughManager: vi.fn(),
  toast: vi.fn(),
  lease: null as {
    readonly leaseId: string;
    readonly sandboxId: string;
    readonly managerEnvironmentId: string;
  } | null,
  commands: {
    updateServer: Symbol("updateServer"),
    upgradeProvisionedEnvironment: Symbol("upgradeProvisionedEnvironment"),
  },
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) => selector({ continueThreadsAfterServerUpdate: false }),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: testState.commands,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: symbol) =>
    command === testState.commands.upgradeProvisionedEnvironment
      ? testState.upgradeThroughManager
      : testState.updateServer,
}));
// The guest's own session grants nothing: a manager upgrade must not need it.
const unauthorizedSession = AsyncResult.success({ authenticated: false });
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => unauthorizedSession }));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => unauthorizedSession } }));
vi.mock("~/cloud/provisionedSandboxLeases", () => ({
  provisionedSandboxOwnedByEnvironment: () => testState.lease,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: testState.toast },
}));

import { ServerUpdateAction } from "../components/ServerUpdateAction";
import { describeUpgradeResult, resolveServerUpdatePath } from "./guestServerUpdate";

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("a provisioned guest's server update", () => {
  beforeEach(() => {
    testState.updateServer.mockReset();
    testState.upgradeThroughManager.mockReset();
    testState.toast.mockReset();
    testState.lease = null;
  });

  it("upgrades a leased guest through its manager instead of copying the public command", async () => {
    testState.lease = {
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      managerEnvironmentId: "manager",
    };
    testState.upgradeThroughManager.mockResolvedValue(
      AsyncResult.success({ kind: "upgraded" as const, t3Revision: "abcdef0123456789" }),
    );

    const action = ServerUpdateAction({
      environmentId: "env-test" as EnvironmentId,
      serverLabel: "Test server",
      selfUpdate: null,
      targetVersion: "0.0.31",
    }) as ReactElement<{ readonly onClick?: () => void; readonly children?: unknown }>;
    expect(action.props.children).toBe("Update via manager");
    action.props.onClick?.();
    await flushPromises();

    expect(testState.upgradeThroughManager).toHaveBeenCalledWith({
      environmentId: "manager",
      input: { leaseId: "lease-1", sandboxId: "sandbox-1", environmentId: "env-test" },
    });
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(testState.toast).toHaveBeenCalledWith({
      type: "success",
      title: "Test server updated",
      description: "Now on abcdef0",
    });
  });
});

describe("resolveServerUpdatePath", () => {
  const lease = {
    leaseId: "lease-1",
    sandboxId: "sandbox-1",
    managerEnvironmentId: EnvironmentId.make("manager"),
  };

  it("upgrades through the manager when the guest cannot update itself", () => {
    expect(resolveServerUpdatePath({ selfUpdate: null, lease })).toEqual({
      kind: "manager-upgrade",
      lease,
    });
  });

  it("keeps the server's own update path when it advertises one", () => {
    expect(resolveServerUpdatePath({ selfUpdate: "respawn", lease })).toEqual({
      kind: "self-update",
      capability: "respawn",
    });
    expect(resolveServerUpdatePath({ selfUpdate: "desktop-managed", lease: null })).toEqual({
      kind: "self-update",
      capability: "desktop-managed",
    });
  });

  it("falls back to the manual command without a lease or self-update", () => {
    expect(resolveServerUpdatePath({ selfUpdate: null, lease: null })).toEqual({
      kind: "manual-command",
    });
  });
});

describe("describeUpgradeResult", () => {
  it("reports the new revision after an upgrade", () => {
    expect(
      describeUpgradeResult(
        { kind: "upgraded", t3Revision: "0123456789abcdef0123456789abcdef01234567" },
        "Cloud sandbox server",
      ),
    ).toEqual({
      type: "success",
      title: "Cloud sandbox server updated",
      description: "Now on 0123456",
    });
  });

  it("says nothing changed when the guest already runs the manager's build", () => {
    expect(
      describeUpgradeResult({ kind: "current", t3Revision: "abcdef0" }, "Cloud sandbox server"),
    ).toEqual({
      type: "info",
      title: "Cloud sandbox server is already on the manager's build",
    });
  });

  it("surfaces the manager's refusal message", () => {
    expect(
      describeUpgradeResult(
        { kind: "refused", reason: "busy", message: "A turn is still running." },
        "Cloud sandbox server",
      ),
    ).toEqual({
      type: "error",
      title: "Cloud sandbox server update refused",
      description: "A turn is still running.",
    });
  });
});
