// @effect-diagnostics nodeBuiltinImport:off - these tests use a temporary filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentControl } from "./EnvironmentControl.ts";
import type { ManagedTarget } from "./config.ts";
import { ProvisionRefused } from "./driver.ts";
import type { CloudDriver, Observation } from "./driver.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

const target: ManagedTarget = {
  environmentId: EnvironmentId.make("cloud"),
  label: "Cloud",
  hostId: "host",
  operatorToken: "private",
  machine: { provider: "e2b", sandboxId: "private-sandbox", metadata: { owner: "private" } },
};
function setup(initial: Observation = { kind: "stopped" }) {
  let state = initial;
  const calls: string[] = [];
  const driver: CloudDriver = {
    // Provisioning creates environments rather than controlling declared ones,
    // so the control cases never reach it; the provisioning case below does.
    provision: async () => {
      calls.push("provision");
      throw new ProvisionRefused("unconfigured", "no template here");
    },
    dispose: async () => {
      calls.push("dispose");
    },
    pause: async () => {
      calls.push("pause");
    },
    observe: async () => {
      calls.push("observe");
      return state;
    },
    observeBroker: async () => {
      calls.push("broker-status");
      return { kind: "stopped" };
    },
    bootstrapBroker: async () => {
      calls.push("bootstrap");
    },
    wake: async () => {
      calls.push("wake");
      state = { kind: "running", instanceId: "private-sandbox" };
    },
    stop: async () => {
      calls.push("stop");
      state = { kind: "stopped" };
      return { kind: "stopped" };
    },
  };
  return { driver, calls, manager: createEnvironmentControl([target], driver) };
}
describe("managed cloud commands", () => {
  it("refresh only observes targets and never contacts or bootstraps the broker", async () => {
    const { manager, calls } = setup();
    const list = await manager.list();
    await manager.list();
    expect(calls).toEqual(["observe", "observe"]);
    expect(list[0]).toMatchObject({
      environmentId: "cloud",
      provider: "e2b",
      state: { kind: "stopped" },
    });
    expect(JSON.stringify(list)).not.toContain("private");
  });
  it("bootstraps before wake and a repeated start is a no-op", async () => {
    const { manager, calls } = setup();
    expect(await manager.start(target.environmentId)).toMatchObject({
      kind: "updated",
      environment: { state: { kind: "running" } },
    });
    await manager.start(target.environmentId);
    expect(calls.filter((call) => call !== "observe")).toEqual([
      "broker-status",
      "bootstrap",
      "wake",
    ]);
  });
  it("stopping a stopped target never touches the broker", async () => {
    const { manager, calls } = setup();
    expect(await manager.stop(target.environmentId)).toMatchObject({
      kind: "updated",
      environment: { state: { kind: "stopped" } },
    });
    expect(calls).toEqual(["observe", "observe"]);
  });
  it("coalesces equal commands and rejects opposite commands during a launch", async () => {
    const { driver, calls } = setup();
    let resume: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resume = resolve;
    });
    driver.bootstrapBroker = async () => {
      calls.push("bootstrap");
      await ready;
    };
    const manager = createEnvironmentControl([target], driver);
    const first = manager.start(target.environmentId);
    expect(manager.start(target.environmentId)).toBe(first);
    expect(await manager.stop(target.environmentId)).toMatchObject({
      kind: "refused",
      reason: "conflict",
    });
    resume?.();
    await first;
    expect(calls.filter((call) => call === "wake")).toEqual(["wake"]);
  });
  it.each(["busy", "unknown", "stale", "unprepared", "unsupported"] as const)(
    "preserves %s stop refusal",
    async (reason) => {
      const { driver, calls } = setup({ kind: "running", instanceId: "instance" });
      driver.observeBroker = async () => ({ kind: "running", instanceId: "broker" });
      driver.stop = async (_target, instanceId) => {
        expect(instanceId).toBe("instance");
        return { kind: "refused", reason };
      };
      const manager = createEnvironmentControl([target], driver);
      expect(await manager.stop(target.environmentId)).toMatchObject({ kind: "refused", reason });
      expect(calls).toEqual(["observe"]);
    },
  );
  it("refuses stop when the broker is paused without resuming it", async () => {
    const { manager, calls } = setup({ kind: "running", instanceId: "instance" });
    expect(await manager.stop(target.environmentId)).toMatchObject({
      kind: "refused",
      reason: "unknown",
    });
    expect(calls).toEqual(["observe", "broker-status"]);
  });
  it("does not expose driver errors or attempt control after an unknown observation", async () => {
    const { manager, driver, calls } = setup();
    driver.observe = async () => {
      throw new Error("secret-token-and-url");
    };
    expect(await manager.start(target.environmentId)).toMatchObject({
      kind: "refused",
      reason: "unknown",
    });
    expect(JSON.stringify(await manager.list())).not.toContain("secret");
    expect(calls).toEqual([]);
  });

  it("disposes a provisioned sandbox through the cloud driver", async () => {
    const { manager, driver, calls } = setup();
    await manager.dispose({ sandboxId: "provisioned-sandbox" });
    expect(calls).toEqual(["dispose"]);
    driver.dispose = async () => {
      throw new Error("provider unavailable");
    };
    await expect(manager.dispose({ sandboxId: "provisioned-sandbox" })).resolves.toEqual({
      kind: "refused",
      reason: "unknown",
      message: "The cloud sandbox could not be disposed.",
    });
  });

  it("registers a provisioned sandbox and disposes it idempotently", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-control-"));
    try {
      const registry = createProvisionedLeaseRegistry(NodePath.join(directory, "leases.json"));
      const { driver } = setup();
      let disposeCalls = 0;
      driver.provision = async () => ({
        provider: "e2b",
        sandboxId: "provisioned-sandbox",
        pairingUrl: "https://example.test/pair",
        projectDir: "/home/user/work/project",
      });
      driver.dispose = async () => {
        disposeCalls += 1;
      };
      const manager = createEnvironmentControl([target], driver, registry);
      const provisioned = await manager.provision({
        provider: "e2b",
        providerInstanceId: "codex",
        repository: undefined,
        branch: undefined,
      });
      expect(provisioned.kind).toBe("provisioned");
      if (provisioned.kind !== "provisioned") return;
      const leaseId = provisioned.environment.leaseId;
      expect(leaseId).toMatch(/^[0-9a-f-]{36}$/);
      if (!leaseId) return;
      await expect(
        manager.claim({
          leaseId,
          environmentId: EnvironmentId.make("remote"),
          threadId: "thread-1",
        }),
      ).resolves.toEqual({ kind: "claimed" });
      await expect(
        manager.pause({ leaseId, sandboxId: provisioned.environment.sandboxId }),
      ).resolves.toEqual({ kind: "paused" });
      await expect(
        registry.findBySandbox(provisioned.environment.sandboxId),
      ).resolves.toMatchObject({
        state: "paused",
      });
      await expect(
        manager.dispose({
          leaseId,
          sandboxId: provisioned.environment.sandboxId,
        }),
      ).resolves.toEqual({ kind: "disposed" });
      await expect(
        manager.dispose({
          leaseId,
          sandboxId: provisioned.environment.sandboxId,
        }),
      ).resolves.toEqual({ kind: "disposed" });
      expect(disposeCalls).toBe(1);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("pauses an expired lease without disposing the provider resource", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-control-"));
    try {
      const registry = createProvisionedLeaseRegistry(NodePath.join(directory, "leases.json"));
      await registry.register({
        leaseId: "expired-lease",
        sandboxId: "expired-sandbox",
        provider: "e2b",
        providerInstanceId: "codex",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const calls: string[] = [];
      const driver = setup().driver;
      driver.pause = async () => {
        calls.push("pause");
      };
      driver.dispose = async () => {
        calls.push("dispose");
      };
      const manager = createEnvironmentControl([], driver, registry);
      await manager.reapExpiredLeases();
      expect(calls).toEqual(["pause"]);
      expect(await registry.findBySandbox("expired-sandbox")).toMatchObject({ state: "paused" });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

it("answers a declined provisioning request instead of failing", async () => {
  // An install with no template is an ordinary configuration state. Reporting
  // it as a provider failure would send the operator looking at the provider.
  const { manager } = setup();
  const refusal = await manager.provision({
    provider: "e2b",
    providerInstanceId: "codex_ac3",
    repository: undefined,
    branch: undefined,
  });
  expect(refusal).toEqual({
    kind: "refused",
    reason: "unconfigured",
    message: "no template here",
  });
});
