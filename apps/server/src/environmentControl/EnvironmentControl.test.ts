// @effect-diagnostics nodeBuiltinImport:off - these tests use a temporary filesystem boundary.
// @effect-diagnostics globalDate:off - these tests use fixed registry timestamps.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentControl } from "./EnvironmentControl.ts";
import type { ManagedTarget } from "./config.ts";
import { ProvisionRefused } from "./ProvisioningProviderProfile.ts";
import { ProvisionedSandboxMissing, type CloudDriver, type Observation } from "./driver.ts";
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
      throw new ProvisionRefused({ reason: "unconfigured", message: "no template here" });
    },
    dispose: async () => {
      calls.push("dispose");
    },
    pause: async () => {
      calls.push("pause");
    },
    resume: async () => {
      calls.push("resume");
      return {};
    },
    renew: async () => "running",
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
  const resumeInput = {
    leaseId: "lease",
    sandboxId: "sandbox",
    environmentId: EnvironmentId.make("child"),
    threadId: "thread",
  };
  async function withLease(
    test: (context: {
      registry: ReturnType<typeof createProvisionedLeaseRegistry>;
      driver: CloudDriver;
      manager: ReturnType<typeof createEnvironmentControl>;
    }) => Promise<void>,
  ) {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-resume-"));
    try {
      const registry = createProvisionedLeaseRegistry(NodePath.join(directory, "leases.json"));
      await registry.register({
        leaseId: "lease",
        sandboxId: "sandbox",
        providerInstanceId: "codex",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await registry.claim({
        leaseId: "lease",
        owner: { environmentId: "child", threadId: "thread" },
      });
      const driver = setup().driver;
      await test({ registry, driver, manager: createEnvironmentControl([], driver, registry) });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }
  it("renews the provider before recording a successful heartbeat", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      const started = Promise.withResolvers<void>();
      const renewed = Promise.withResolvers<void>();
      driver.renew = vi.fn<CloudDriver["renew"]>(async () => {
        started.resolve();
        await renewed.promise;
        return "running";
      });
      const touched = manager.touch({ leaseId: "lease" });
      await started.promise;
      expect(await registry.findById("lease")).toMatchObject({
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
      expect(await manager.pause(resumeInput)).toMatchObject({ kind: "refused" });
      expect(await manager.resume(resumeInput)).toMatchObject({ kind: "refused" });
      expect(await manager.dispose(resumeInput)).toMatchObject({ kind: "refused" });
      await manager.reapExpiredLeases();
      renewed.resolve();
      expect(await touched).toEqual({ kind: "touched" });
      expect(driver.renew).toHaveBeenCalledWith({
        sandboxId: "sandbox",
        providerInstanceId: "codex",
      });
      expect(await registry.expired()).toEqual([]);
    });
  });
  it("does not extend the local lease when provider renewal fails", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.renew = vi
        .fn()
        .mockRejectedValueOnce(new Error("secret-provider-token"))
        .mockResolvedValue("running");
      expect(await manager.touch({ leaseId: "lease" })).toEqual({
        kind: "refused",
        reason: "unknown",
        message: "The cloud sandbox deadline could not be renewed. Retry shortly.",
      });
      expect(await registry.findById("lease")).toMatchObject({
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
      expect(await manager.touch({ leaseId: "lease" })).toEqual({ kind: "touched" });
    });
  });
  it("records a provider pause without renewing or resuming the workspace", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.renew = vi.fn().mockResolvedValue("paused");
      driver.resume = vi.fn();
      expect(await manager.touch({ leaseId: "lease" })).toEqual({
        kind: "refused",
        reason: "unknown",
        message: "The workspace is paused. Reconnect to continue.",
      });
      expect(await registry.findById("lease")).toMatchObject({
        state: "paused",
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
      expect(driver.resume).not.toHaveBeenCalled();
    });
  });
  it("remembers a missing provider workspace and refuses subsequent reconnects", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.renew = vi.fn().mockResolvedValue("missing");
      driver.resume = vi.fn();
      const expected = {
        kind: "refused",
        reason: "unknown",
        message: "E2B no longer has this workspace. It cannot be reconnected.",
      };
      expect(await manager.touch({ leaseId: "lease" })).toEqual(expected);
      expect(await registry.findById("lease")).toMatchObject({ state: "missing" });
      expect(await manager.touch({ leaseId: "lease" })).toEqual(expected);
      expect(await manager.resume(resumeInput)).toEqual(expected);
      expect(driver.renew).toHaveBeenCalledTimes(1);
      expect(driver.resume).not.toHaveBeenCalled();
      expect(await registry.expired()).toEqual([]);
    });
  });
  it("records a missing workspace discovered during explicit reconnect", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.resume = vi.fn().mockRejectedValue(new ProvisionedSandboxMissing());
      const expected = {
        kind: "refused",
        reason: "unknown",
        message: "E2B no longer has this workspace. It cannot be reconnected.",
      };
      expect(await manager.resume(resumeInput)).toEqual(expected);
      expect(await manager.resume(resumeInput)).toEqual(expected);
      expect(driver.resume).toHaveBeenCalledTimes(1);
      expect(await registry.findById("lease")).toMatchObject({ state: "missing" });
    });
  });
  it("does not renew unclaimed or unknown workspaces", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.register({
        leaseId: "unclaimed",
        sandboxId: "other",
        providerInstanceId: "codex",
      });
      driver.renew = vi.fn();
      for (const leaseId of ["unclaimed", "unknown"]) {
        expect(await manager.touch({ leaseId })).toMatchObject({ kind: "refused" });
      }
      expect(driver.renew).not.toHaveBeenCalled();
    });
  });
  it("keeps Namespace heartbeats independent of E2B", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.register({
        leaseId: "namespace",
        sandboxId: "devbox",
        providerInstanceId: "codex",
        namespaceResource: {
          provider: "namespace",
          devboxId: "devbox",
          instanceId: "instance",
          region: "us",
          workspaceDir: "/Volumes/devbox/work",
        },
      });
      await registry.claim({
        leaseId: "namespace",
        owner: { environmentId: "child", threadId: "thread" },
      });
      driver.renew = vi.fn();
      expect(await manager.touch({ leaseId: "namespace" })).toEqual({ kind: "touched" });
      expect(driver.renew).not.toHaveBeenCalled();
    });
  });
  it("resumes the retained owned workspace and renews its lease only after provider readiness", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.markPaused("lease");
      const ready = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      driver.resume = vi.fn(async () => {
        started.resolve();
        await ready.promise;
        return {};
      });
      const resumed = manager.resume(resumeInput);
      await started.promise;
      expect(await registry.findBySandbox("sandbox")).toMatchObject({
        state: "paused",
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
      expect(manager.resume(resumeInput)).toBe(resumed);
      expect(await manager.pause(resumeInput)).toMatchObject({ kind: "refused" });
      expect(await manager.dispose(resumeInput)).toMatchObject({ kind: "refused" });
      await manager.reapExpiredLeases();
      ready.resolve();
      expect(await resumed).toEqual({ kind: "resumed" });
      expect(driver.resume).toHaveBeenCalledTimes(1);
      expect(driver.resume).toHaveBeenCalledWith({
        sandboxId: "sandbox",
        environmentId: "child",
        providerInstanceId: "codex",
      });
      expect(await registry.findBySandbox("sandbox")).toMatchObject({
        state: "active",
        owner: { environmentId: "child", threadId: "thread" },
      });
      expect(await registry.expired()).toEqual([]);
      expect(await manager.resume(resumeInput)).toEqual({ kind: "resumed" });
      expect(driver.resume).toHaveBeenCalledTimes(2);
    });
  });
  it("leaves failed recovery paused and allows another attempt", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.markPaused("lease");
      driver.resume = vi
        .fn()
        .mockRejectedValueOnce(new Error("secret-provider-token"))
        .mockResolvedValue({});
      const failure = await manager.resume(resumeInput);
      expect(failure).toEqual({
        kind: "refused",
        reason: "unknown",
        message: "The workspace could not be reconnected. Retry shortly.",
      });
      expect(await registry.findBySandbox("sandbox")).toMatchObject({ state: "paused" });
      expect(await manager.resume(resumeInput)).toEqual({ kind: "resumed" });
    });
  });
  it("refuses an unknown lease or wrong owner without contacting the provider", async () => {
    await withLease(async ({ driver, manager }) => {
      driver.resume = vi.fn();
      for (const changed of [
        { leaseId: "other" },
        { sandboxId: "other" },
        { environmentId: EnvironmentId.make("other") },
        { threadId: "other" },
      ]) {
        expect(await manager.resume({ ...resumeInput, ...changed })).toMatchObject({
          kind: "refused",
        });
      }
      expect(driver.resume).not.toHaveBeenCalled();
    });
  });
  it.each(["releasing", "disposed"] as const)("cannot revive a %s lease", async (state) => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.beginRelease(resumeInput);
      if (state === "disposed") await registry.markDisposed("lease");
      driver.resume = vi.fn();
      expect(await manager.resume(resumeInput)).toMatchObject({ kind: "refused" });
      expect(await manager.pause(resumeInput)).toMatchObject({ kind: "refused" });
      expect(await registry.findBySandbox("sandbox")).toMatchObject({ state });
      expect(driver.resume).not.toHaveBeenCalled();
    });
  });
  it("refuses resume while the reaper is pausing the same resource", async () => {
    await withLease(async ({ driver, manager, registry }) => {
      const started = Promise.withResolvers<void>();
      const paused = Promise.withResolvers<void>();
      driver.pause = async () => {
        started.resolve();
        await paused.promise;
      };
      const reaped = manager.reapExpiredLeases();
      await started.promise;
      expect(await manager.resume(resumeInput)).toMatchObject({ kind: "refused" });
      paused.resolve();
      await reaped;
      expect(await registry.findBySandbox("sandbox")).toMatchObject({ state: "paused" });
      expect(await manager.resume(resumeInput)).toEqual({ kind: "resumed" });
    });
  });
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
