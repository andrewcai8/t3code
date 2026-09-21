// @effect-diagnostics nodeBuiltinImport:off - these tests use a temporary filesystem boundary.
// @effect-diagnostics globalDate:off - these tests use fixed registry timestamps.
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentControl } from "./EnvironmentControl.ts";
import type { ManagedTarget } from "./config.ts";
import { ProvisionRefused } from "./ProvisioningProviderProfile.ts";
import { ProvisionedSandboxMissing, type CloudDriver, type Observation } from "./driver.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

/**
 * Leases live in SQLite beside provision_operations, so tests need a client.
 *
 * The suite around this is plain async against a Promise-facing service, so the
 * layer is run here rather than converting every case to `it.effect`.
 */
const withSqlRegistry = (
  body: (registry: ReturnType<typeof createProvisionedLeaseRegistry>) => Promise<void>,
) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.promise(() => body(createProvisionedLeaseRegistry(sql)));
    }).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped),
  );

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
    await withSqlRegistry(async (registry) => {
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
    });
  }
  it("records a missing workspace on settle and keeps repeat settles idempotent", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.pause = vi.fn().mockResolvedValue("missing");
      expect(await manager.pause(resumeInput)).toEqual({ kind: "missing" });
      expect(await registry.findById("lease")).toMatchObject({ state: "missing" });
      expect(await manager.pause(resumeInput)).toEqual({ kind: "missing" });
      expect(driver.pause).toHaveBeenCalledTimes(1);
      expect(await manager.resume(resumeInput)).toMatchObject({ reason: "missing" });
    });
  });

  it("keeps the lease active when pause fails without confirming absence", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.pause = vi.fn().mockRejectedValue(new Error("permission denied"));
      expect(await manager.pause(resumeInput)).toMatchObject({ kind: "refused" });
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
    });
  });

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
        reason: "missing",
        message: "The cloud provider no longer has this workspace. It cannot be reconnected.",
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
        reason: "missing",
        message: "The cloud provider no longer has this workspace. It cannot be reconnected.",
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
        leaseId: "lease",
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
  it("disposes a lease whose provider resource is already gone", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      driver.resume = async () => {
        throw new ProvisionedSandboxMissing();
      };
      expect(await manager.resume(resumeInput)).toMatchObject({ reason: "missing" });
      driver.dispose = async () => {
        throw new Error("Sandbox sandbox not reachable");
      };
      expect(await manager.dispose(resumeInput)).toEqual({ kind: "disposed" });
      expect(await registry.findBySandbox("sandbox")).toMatchObject({ state: "disposed" });
      expect(await manager.dispose(resumeInput)).toEqual({ kind: "disposed" });
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

  it("records provider absence while reaping an expired lease", async () => {
    await withSqlRegistry(async (registry) => {
      await registry.register({
        leaseId: "expired-lease",
        sandboxId: "expired-sandbox",
        provider: "e2b",
        providerInstanceId: "codex",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const driver = setup().driver;
      driver.pause = vi.fn().mockResolvedValue("missing");
      const manager = createEnvironmentControl([], driver, registry);
      await manager.reapExpiredLeases();
      expect(await registry.findById("expired-lease")).toMatchObject({ state: "missing" });
      await manager.reapExpiredLeases();
      expect(driver.pause).toHaveBeenCalledTimes(1);
    });
  });

  it("pauses an expired lease without disposing the provider resource", async () => {
    await withSqlRegistry(async (registry) => {
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
    });
  });
});

describe("a cloud machine whose agent is working", () => {
  const pauseInput = { leaseId: "lease", sandboxId: "sandbox" };
  async function withExpiredLease(
    activity: "busy" | "idle" | "unknown",
    test: (context: {
      registry: ReturnType<typeof createProvisionedLeaseRegistry>;
      calls: string[];
      checked: string[];
      manager: ReturnType<typeof createEnvironmentControl>;
    }) => Promise<void>,
    retentionDeadline?: string,
  ) {
    await withSqlRegistry(async (registry) => {
      await registry.register({
        leaseId: "lease",
        sandboxId: "sandbox",
        provider: "e2b",
        providerInstanceId: "codex",
        ...(retentionDeadline ? { retentionDeadline } : {}),
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await registry.claim({
        leaseId: "lease",
        owner: { environmentId: "child", threadId: "thread" },
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const calls: string[] = [];
      const checked: string[] = [];
      const driver = setup().driver;
      driver.pause = async ({ sandboxId }) => {
        calls.push(`pause:${sandboxId}`);
      };
      const manager = createEnvironmentControl([], driver, registry, async (lease) => {
        checked.push(lease.leaseId);
        return activity;
      });
      await test({ registry, calls, checked, manager });
    });
  }

  it("keeps an expired lease running and renews it while its agent is busy", async () => {
    await withExpiredLease("busy", async ({ registry, calls, checked, manager }) => {
      await manager.reapExpiredLeases();
      expect(calls).toEqual([]);
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
      expect(await registry.expired()).toEqual([]);
      expect(checked).toEqual(["lease"]);
    });
  });

  it.each(["idle", "unknown"] as const)(
    "pauses an expired lease when its agent is %s",
    async (activity) => {
      await withExpiredLease(activity, async ({ registry, calls, manager }) => {
        await manager.reapExpiredLeases();
        expect(calls).toEqual(["pause:sandbox"]);
        expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
      });
    },
  );

  it("pauses a busy machine whose retention deadline has passed", async () => {
    await withExpiredLease(
      "busy",
      async ({ registry, calls, manager }) => {
        await manager.reapExpiredLeases();
        expect(calls).toEqual(["pause:sandbox"]);
        expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
      },
      "2026-01-01T00:10:00.000Z",
    );
  });

  it("refuses to pause for one chat while the machine's agent is busy", async () => {
    await withExpiredLease("busy", async ({ registry, calls, manager }) => {
      expect(await manager.pause(pauseInput)).toEqual({
        kind: "refused",
        reason: "unknown",
        message: "Another chat on this machine is still working.",
      });
      expect(calls).toEqual([]);
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
    });
  });

  it("pauses on request when the machine's activity cannot be read", async () => {
    await withExpiredLease("unknown", async ({ registry, calls, manager }) => {
      expect(await manager.pause(pauseInput)).toEqual({ kind: "paused" });
      expect(calls).toEqual(["pause:sandbox"]);
      expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
    });
  });
});
