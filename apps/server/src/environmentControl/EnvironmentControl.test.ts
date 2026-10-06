// @effect-diagnostics nodeBuiltinImport:off - these tests use a temporary filesystem boundary.
// @effect-diagnostics globalDate:off - these tests use fixed registry timestamps.
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentControl } from "./EnvironmentControl.ts";
import { createCleanupSweep } from "./cloudCleanup.ts";
import type { ManagedTarget } from "./config.ts";
import { ProvisionedSandboxMissing, type CloudDriver, type Observation } from "./driver.ts";
import { E2bPlacementUnavailable } from "./e2bResume.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { ownerChat, type ProvisionedChatStore } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";

/**
 * Leases live in SQLite beside provision_operations, so tests need a client.
 *
 * The suite around this is plain async against a Promise-facing service, so the
 * layer is run here rather than converting every case to `it.effect`.
 */
const withSqlRegistry = (
  body: (registry: ReturnType<typeof createProvisionedLeaseRegistry>) => Promise<void>,
) =>
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- the suite drives a Promise-facing service
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.promise(() => body(createProvisionedLeaseRegistry(sql)));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped),
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

  it("pauses a saved chat whose Mac its upkeep released, and leaves a box another operation holds", async () => {
    await withLease(async ({ registry, driver }) => {
      const results: Array<"kept" | "released" | null> = ["kept", "released"];
      const upkept: string[] = [];
      let release: (() => void) | undefined;
      const resumeHeld = new Promise<void>((resolve) => (release = resolve));
      const manager = createEnvironmentControl(
        [],
        {
          ...driver,
          resume: async () => {
            await resumeHeld;
            return {};
          },
          upkeepChat: async ({ sandboxId }) => {
            upkept.push(sandboxId);
            return results.shift() ?? null;
          },
        },
        registry,
        async () => ({ activity: "idle" }),
      );
      await manager.upkeepCloudChats();
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
      const resuming = manager.resume(resumeInput);
      await manager.upkeepCloudChats();
      expect(upkept, "a resume in flight holds the box").toEqual(["sandbox"]);
      release?.();
      await resuming;
      await manager.upkeepCloudChats();
      expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
      expect(upkept).toEqual(["sandbox", "sandbox"]);
    });
  });

  it("puts a chat its upkeep moved off a Mac back on one without a client, retrying until it lands", async () => {
    await withLease(async ({ registry, driver }) => {
      const outcomes: Array<Error | "moved"> = [new Error("no Mac yet"), "moved"];
      const reported: string[] = [];
      const manager = createEnvironmentControl(
        [],
        {
          ...driver,
          resume: async () => {
            const outcome = outcomes.shift();
            if (outcome instanceof Error) throw outcome;
            if (outcome === undefined) throw new ProvisionedSandboxMissing();
            return { namespaceProxy: { proxyId: "proxy", proxyOrigin: "https://moved.example" } };
          },
          upkeepChat: async () => "reopen",
        },
        registry,
        async () => ({ activity: "busy" }),
        async () => {},
        (message) => reported.push(message),
      );
      await manager.upkeepCloudChats();
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
      expect(reported).toEqual(["cloud chat upkeep failed"]);
      await manager.upkeepCloudChats();
      expect(await registry.findById("lease")).toMatchObject({
        state: "active",
        namespaceProxy: { proxyId: "proxy", proxyOrigin: "https://moved.example" },
      });
      await manager.upkeepCloudChats();
      expect(
        await registry.findById("lease"),
        "an expired snapshot ends the retries",
      ).toMatchObject({ state: "missing" });
    });
  });

  it("moves a working chat at most three times in a row with no client, then lets it sleep until opened", async () => {
    await withLease(async ({ registry, driver }) => {
      const resumes: Array<Error | "moved"> = [new Error("no Mac yet")];
      const paused: string[] = [];
      const manager = createEnvironmentControl(
        [],
        {
          ...driver,
          resume: async () => {
            const outcome = resumes.shift() ?? "moved";
            if (outcome instanceof Error) throw outcome;
            return {};
          },
          pause: async ({ sandboxId }) => void paused.push(sandboxId),
          // Every pass finds the chat still working at its Mac's deadline.
          upkeepChat: async () => "reopen",
        },
        registry,
        async () => ({ activity: "busy" }),
      );
      const pass = async () => {
        await manager.upkeepCloudChats();
        return (await registry.findById("lease"))?.state;
      };
      const passes = async (count: number) => {
        const states: Array<string | undefined> = [];
        for (let index = 0; index < count; index++) states.push(await pass());
        return states;
      };

      expect(await passes(5), "a failed move is not counted").toEqual([
        "active",
        "active",
        "active",
        "active",
        "paused",
      ]);
      expect(paused).toEqual(["sandbox"]);
      expect(await pass(), "a paused chat is not moved").toBe("paused");

      expect(await manager.resume(resumeInput)).toEqual({ kind: "resumed" });
      expect(await passes(2)).toEqual(["active", "active"]);
      expect(await manager.touch({ leaseId: "lease" })).toEqual({ kind: "touched" });
      expect(await passes(4), "a client heartbeat starts the count again").toEqual([
        "active",
        "active",
        "active",
        "paused",
      ]);
    });
  });

  it("upkeeps each chat on its own, so one slow save never holds up another chat's deadline", async () => {
    await withSqlRegistry(async (registry) => {
      // The slow chat is listed first, so a pass that awaited chats in turn would never reach the other.
      for (const id of ["a-slow", "b-quick"])
        await registry.register({
          leaseId: id,
          sandboxId: id,
          providerInstanceId: "codex",
          now: new Date("2026-01-01T00:00:00.000Z"),
        });
      const upkept: string[] = [];
      let finishSlow: (() => void) | undefined;
      const slowSave = new Promise<void>((resolve) => (finishSlow = resolve));
      let slowStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => (slowStarted = resolve));
      const manager = createEnvironmentControl(
        [],
        {
          ...setup().driver,
          upkeepChat: async ({ sandboxId }) => {
            upkept.push(sandboxId);
            if (sandboxId === "a-slow") {
              slowStarted?.();
              await slowSave;
            }
            return "kept";
          },
        },
        registry,
        async () => ({ activity: "idle" }),
      );
      const first = manager.upkeepCloudChats();
      await started;
      await manager.upkeepCloudChats();
      expect(
        upkept,
        "the quick chat ran on both ticks; the slow one never overlapped itself",
      ).toEqual(["a-slow", "b-quick", "b-quick"]);
      finishSlow?.();
      await first;
    });
  });

  it("reports a failed upkeep with its chat and cause instead of swallowing it", async () => {
    await withLease(async ({ registry, driver }) => {
      const reported: Array<{ message: string; chatId: string | undefined; cause: string }> = [];
      const manager = createEnvironmentControl(
        [],
        {
          ...driver,
          upkeepChat: async () => {
            throw new Error(
              "The chat snapshot exceeds 4294967296 bytes; a cache is probably being saved",
            );
          },
        },
        registry,
        async () => ({ activity: "idle" }),
        async () => {},
        (message, { chatId, cause }) =>
          reported.push({
            message,
            chatId,
            cause: cause instanceof Error ? cause.message : String(cause),
          }),
      );
      await manager.upkeepCloudChats();
      expect(reported).toEqual([
        {
          message: "cloud chat upkeep failed",
          chatId: "lease",
          cause: "The chat snapshot exceeds 4294967296 bytes; a cache is probably being saved",
        },
      ]);
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
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
  it.each(["active", "paused"] as const)(
    "resumes an unclaimed retained workspace from the %s state without assigning an owner",
    async (state) => {
      await withSqlRegistry(async (registry) => {
        await registry.register({
          leaseId: "unclaimed",
          sandboxId: "unclaimed-sandbox",
          providerInstanceId: "codex",
          now: new Date("2026-01-01T00:00:00.000Z"),
        });
        if (state === "paused") await registry.markPaused("unclaimed");
        const driver = setup().driver;
        driver.resume = vi.fn().mockResolvedValue({});
        const manager = createEnvironmentControl([], driver, registry);

        expect(
          await manager.resume({
            leaseId: "unclaimed",
            sandboxId: "unclaimed-sandbox",
            environmentId: EnvironmentId.make("child"),
          }),
        ).toEqual({ kind: "resumed" });
        expect(driver.resume).toHaveBeenCalledWith({
          leaseId: "unclaimed",
          sandboxId: "unclaimed-sandbox",
          environmentId: "child",
          providerInstanceId: "codex",
        });
        expect(await registry.findById("unclaimed")).toMatchObject({
          state: "active",
          owner: null,
        });
      });
    },
  );
  it("reports a missing unclaimed workspace without contacting the provider", async () => {
    await withSqlRegistry(async (registry) => {
      await registry.register({
        leaseId: "unclaimed",
        sandboxId: "unclaimed-sandbox",
        providerInstanceId: "codex",
      });
      await registry.markMissing("unclaimed");
      const driver = setup().driver;
      driver.resume = vi.fn();
      const manager = createEnvironmentControl([], driver, registry);

      expect(
        await manager.resume({
          leaseId: "unclaimed",
          sandboxId: "unclaimed-sandbox",
          environmentId: EnvironmentId.make("child"),
        }),
      ).toMatchObject({ kind: "refused", reason: "missing" });
      expect(driver.resume).not.toHaveBeenCalled();
    });
  });
  it("resumes a paused workspace for its environment whichever thread claimed it", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.markPaused("lease");
      driver.resume = vi.fn().mockResolvedValue({});
      expect(
        await manager.resume({
          leaseId: "lease",
          sandboxId: "sandbox",
          environmentId: EnvironmentId.make("child"),
        }),
      ).toEqual({ kind: "resumed" });
      expect(driver.resume).toHaveBeenCalledWith({
        leaseId: "lease",
        sandboxId: "sandbox",
        environmentId: "child",
        providerInstanceId: "codex",
      });
      expect(await registry.findById("lease")).toMatchObject({
        state: "active",
        owner: { environmentId: "child", threadId: "thread" },
      });
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
  it("says E2B cannot place a box it could not resume for lack of room, and leaves it paused", async () => {
    await withLease(async ({ registry, driver, manager }) => {
      await registry.markPaused("lease");
      driver.resume = vi
        .fn()
        .mockRejectedValue(new E2bPlacementUnavailable("E2B could not place sandbox sandbox"));
      expect(await manager.resume(resumeInput)).toEqual({
        kind: "refused",
        reason: "unknown",
        message: "E2B can't place this machine right now. Retrying.",
      });
      expect(await registry.findBySandbox("sandbox")).toMatchObject({ state: "paused" });
    });
  });
  it("refuses an unknown lease or wrong owner without contacting the provider", async () => {
    await withLease(async ({ driver, manager }) => {
      driver.resume = vi.fn();
      for (const changed of [
        { leaseId: "other" },
        { sandboxId: "other" },
        { environmentId: EnvironmentId.make("other") },
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
  it("leaves an expired box awake while its resume is still preparing it", async () => {
    await withLease(async ({ driver, manager, registry }) => {
      let running = true;
      const preparing = Promise.withResolvers<void>();
      const prepared = Promise.withResolvers<void>();
      driver.pause = async () => {
        running = false;
      };
      driver.resume = async () => {
        preparing.resolve();
        await prepared.promise;
        if (!running) throw new Error("websocket: close 1006 (abnormal closure): unexpected EOF");
        return {};
      };
      const resumed = manager.resume(resumeInput);
      await preparing.promise;
      await manager.reapExpiredLeases();
      prepared.resolve();
      expect(await resumed).toEqual({ kind: "resumed" });
      expect(await registry.findBySandbox("sandbox")).toMatchObject({ state: "active" });
      expect(running).toBe(true);
    });
  });
  it("never idles out a box whose chat's first turn has not started", async () => {
    await withSqlRegistry(async (registry) => {
      await registry.register({
        leaseId: "lease",
        sandboxId: "sandbox",
        providerInstanceId: "codex",
        owner: { environmentId: "child", threadId: "thread" },
        firstTurnPending: true,
        now: new Date(Date.now() - 16 * 60_000),
      });
      const manager = createEnvironmentControl([], setup().driver, registry, async () => ({
        activity: "idle",
      }));
      await manager.reapExpiredLeases();
      expect(await registry.findById("lease")).toMatchObject({ state: "active" });
      await registry.settleFirstTurn("lease", { status: "started" });
      await manager.reapExpiredLeases();
      expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
    });
  });
  it("gives up an overdue first turn itself, so a box no upkeep settles still pauses", async () => {
    await withSqlRegistry(async (registry) => {
      await registry.register({
        leaseId: "lease",
        sandboxId: "sandbox",
        providerInstanceId: "codex",
        owner: { environmentId: "child", threadId: "thread" },
        firstTurnPending: true,
        now: new Date(Date.now() - 31 * 60_000),
      });
      const manager = createEnvironmentControl([], setup().driver, registry, async () => ({
        activity: "idle",
      }));
      await manager.reapExpiredLeases();
      expect(await registry.findById("lease")).toMatchObject({
        state: "paused",
        owner: null,
        firstTurn: { status: "failed", reason: "The box did not take the turn in time." },
      });
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
  let holdBox: ReturnType<typeof createEnvironmentControl>["holdBox"] | undefined;
  async function withExpiredLease(
    activity: "busy" | "idle" | "unknown",
    test: (context: {
      registry: ReturnType<typeof createProvisionedLeaseRegistry>;
      calls: string[];
      checked: string[];
      manager: ReturnType<typeof createEnvironmentControl>;
    }) => Promise<void>,
    retentionDeadline?: string,
    idleUpgrade?: Parameters<typeof createEnvironmentControl>[1]["idleUpgrade"],
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
      const manager = createEnvironmentControl(
        [],
        { ...driver, ...(idleUpgrade ? { idleUpgrade } : {}) },
        registry,
        async (lease) => {
          checked.push(lease.leaseId);
          return { activity };
        },
      );
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

  it("moves an idle box onto the pinned build before it sleeps, then pauses it on the next sweep", async () => {
    let pinnedAhead = true;
    const started: Array<string> = [];
    await withExpiredLease(
      "idle",
      async ({ registry, calls, manager }) => {
        holdBox = manager.holdBox;
        await manager.reapExpiredLeases();
        expect(started).toEqual(["lease:held"]);
        expect(calls).toEqual([]);
        expect(await registry.findById("lease")).toMatchObject({ state: "active" });

        await manager.reapExpiredLeases();
        expect(calls).toEqual(["pause:sandbox"]);
        expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
      },
      undefined,
      {
        due: async () => (pinnedAhead ? "new-build" : null),
        start: (lease) => {
          const release = holdBox?.(lease.sandboxId);
          started.push(`${lease.leaseId}:${release ? "held" : "busy"}`);
          release?.();
          pinnedAhead = false;
        },
      },
    );
  });

  it("lets an idle box sleep on its old build once two upgrades to the pinned one failed", async () => {
    const started: Array<string> = [];
    await withExpiredLease(
      "idle",
      async ({ registry, calls, manager }) => {
        await manager.reapExpiredLeases();
        await manager.reapExpiredLeases();
        expect(calls).toEqual([]);
        await manager.reapExpiredLeases();
        expect(started).toEqual(["lease", "lease"]);
        expect(calls).toEqual(["pause:sandbox"]);
        expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
      },
      undefined,
      { due: async () => "new-build", start: (lease) => void started.push(lease.leaseId) },
    );
  });

  it("never upgrades a box whose activity cannot be read, and pauses it", async () => {
    const started: Array<string> = [];
    await withExpiredLease(
      "unknown",
      async ({ calls, manager }) => {
        await manager.reapExpiredLeases();
        expect(calls).toEqual(["pause:sandbox"]);
        expect(started).toEqual([]);
      },
      undefined,
      { due: async () => "new-build", start: (lease) => void started.push(lease.leaseId) },
    );
  });

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

describe("a cloud box's usage", () => {
  async function withAwakeLease(
    test: (context: {
      registry: ReturnType<typeof createProvisionedLeaseRegistry>;
      events: string[];
      pulled: string[];
      activity: Array<"busy" | "idle" | "unknown">;
      failPulls: { remaining: number };
      manager: ReturnType<typeof createEnvironmentControl>;
    }) => Promise<void>,
  ) {
    await withSqlRegistry(async (registry) => {
      await registry.register({
        leaseId: "lease",
        sandboxId: "sandbox",
        provider: "e2b",
        providerInstanceId: "claude",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await registry.markActive({
        leaseId: "lease",
        remoteAccess: { origin: "http://box.invalid", brokerToken: "broker" },
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      const events: string[] = [];
      const pulled: string[] = [];
      const activity: Array<"busy" | "idle" | "unknown"> = [];
      const failPulls = { remaining: 0 };
      const driver = setup().driver;
      driver.pause = async () => {
        events.push("pause");
      };
      driver.dispose = async () => {
        events.push("dispose");
      };
      const manager = createEnvironmentControl(
        [],
        driver,
        registry,
        async () => ({ activity: activity.shift() ?? "idle" }),
        async (lease) => {
          pulled.push(lease.leaseId);
          events.push("pull");
          if (failPulls.remaining > 0) {
            failPulls.remaining -= 1;
            throw new Error("usage history timed out");
          }
        },
      );
      await test({ registry, events, pulled, activity, failPulls, manager });
    });
  }

  it("pauses a box even when its usage cannot be pulled", async () => {
    await withAwakeLease(async ({ registry, events, failPulls, manager }) => {
      failPulls.remaining = 1;
      expect(await manager.pause({ leaseId: "lease", sandboxId: "sandbox" })).toEqual({
        kind: "paused",
      });
      expect(events).toEqual(["pull", "pause"]);
      expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
    });
  });

  it("pauses an expired box even when its usage cannot be pulled", async () => {
    await withAwakeLease(async ({ registry, events, failPulls, manager }) => {
      failPulls.remaining = 1;
      await manager.reapExpiredLeases();
      expect(events).toEqual(["pull", "pause"]);
      expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
    });
  });

  it("disposes a box even when its usage cannot be pulled", async () => {
    await withAwakeLease(async ({ registry, events, failPulls, manager }) => {
      failPulls.remaining = 1;
      expect(await manager.dispose({ leaseId: "lease", sandboxId: "sandbox" })).toEqual({
        kind: "disposed",
      });
      expect(events).toEqual(["pull", "dispose"]);
      expect(await registry.findById("lease")).toMatchObject({ state: "disposed" });
    });
  });

  it("pulls once when a busy box settles and retries a failed pull", async () => {
    await withAwakeLease(async ({ pulled, activity, failPulls, manager }) => {
      activity.push("busy", "idle", "idle");
      for (let sweep = 0; sweep < 3; sweep += 1) await manager.syncLeaseUsage();
      expect(pulled).toEqual(["lease"]);

      failPulls.remaining = 1;
      activity.push("busy", "idle", "idle", "idle");
      for (let sweep = 0; sweep < 4; sweep += 1) await manager.syncLeaseUsage();
      expect(pulled).toEqual(["lease", "lease", "lease"]);
    });
  });

  it("pulls nothing while a box's activity cannot be read", async () => {
    await withAwakeLease(async ({ pulled, activity, manager }) => {
      activity.push("unknown", "unknown", "idle");
      for (let sweep = 0; sweep < 3; sweep += 1) await manager.syncLeaseUsage();
      expect(pulled).toEqual(["lease"]);
    });
  });
});

describe("a cloud box's chat", () => {
  const chatTitled = (title: string) => {
    const chat = ownerChat(boxShell([boxThread("thread", "project-app", title)]), "thread");
    if (!chat) throw new Error("the fixture shell holds the owner thread");
    return chat;
  };
  async function withChats(
    test: (context: {
      registry: ReturnType<typeof createProvisionedLeaseRegistry>;
      events: string[];
      recorded: Array<readonly [string, string]>;
      carded: Map<string, string>;
      chatless: Set<string>;
      failures: Array<{ message: string; cause: string }>;
      store: { broken: boolean };
      manager: ReturnType<typeof createEnvironmentControl>;
    }) => Promise<void>,
  ) {
    await withSqlRegistry(async (registry) => {
      const events: string[] = [];
      const recorded: Array<readonly [string, string]> = [];
      const carded = new Map<string, string>();
      const chatless = new Set<string>();
      const failures: Array<{ message: string; cause: string }> = [];
      const store = { broken: false };
      const chats: ProvisionedChatStore = {
        record: async (leaseId, chat) => {
          recorded.push([leaseId, chat.thread.title]);
          carded.set(leaseId, chat.thread.id);
        },
        heldThreads: async () => {
          if (store.broken) throw new Error("database is locked");
          return new Map(carded);
        },
        read: async () => null,
      };
      const driver = setup().driver;
      driver.pause = async ({ sandboxId }) => {
        events.push(`pause:${sandboxId}`);
      };
      const manager = createEnvironmentControl(
        [],
        driver,
        registry,
        async (lease) => {
          events.push(`observe:${lease.leaseId}`);
          return {
            activity: "idle",
            chat: chatless.has(lease.leaseId) ? null : chatTitled(`Chat on ${lease.leaseId}`),
          };
        },
        async () => {},
        (message, { cause }) =>
          failures.push({ message, cause: cause instanceof Error ? cause.message : String(cause) }),
        chats,
      );
      await test({ registry, events, recorded, carded, chatless, failures, store, manager });
    });
  }
  const claimedBox = async (
    registry: ReturnType<typeof createProvisionedLeaseRegistry>,
    leaseId: string,
    now?: Date,
  ) => {
    await registry.register({
      leaseId,
      sandboxId: `sandbox-${leaseId}`,
      providerInstanceId: "codex",
      ...(now ? { now } : {}),
    });
    await registry.claim({
      leaseId,
      owner: { environmentId: `box-${leaseId}`, threadId: "thread" },
      ...(now ? { now } : {}),
    });
  };

  it("remembers each awake box's chat on the usage sweep", async () => {
    await withChats(async ({ registry, recorded, manager }) => {
      await claimedBox(registry, "a");
      await claimedBox(registry, "b");
      await manager.syncLeaseUsage();
      expect(recorded.toSorted()).toEqual([
        ["a", "Chat on a"],
        ["b", "Chat on b"],
      ]);
    });
  });

  it("remembers a box's chat right before the reaper pauses it", async () => {
    await withChats(async ({ registry, events, recorded, manager }) => {
      await claimedBox(registry, "lease", new Date("2026-01-01T00:00:00.000Z"));
      await manager.reapExpiredLeases();
      expect(events).toEqual(["observe:lease", "pause:sandbox-lease"]);
      expect(recorded).toEqual([["lease", "Chat on lease"]]);
      expect(await registry.findById("lease")).toMatchObject({ state: "paused" });
    });
  });

  it("reads a new chat once, only from awake claimed boxes the host holds no chat for", async () => {
    await withChats(async ({ registry, events, recorded, carded, manager }) => {
      await claimedBox(registry, "carded");
      carded.set("carded", "thread");
      await claimedBox(registry, "new");
      await claimedBox(registry, "paused");
      await registry.markPaused("paused");
      await registry.register({
        leaseId: "unclaimed",
        sandboxId: "unclaimed",
        providerInstanceId: "codex",
      });
      await Promise.all([manager.readNewChats(), manager.readNewChats()]);
      expect(events).toEqual(["observe:new"]);
      expect(recorded).toEqual([["new", "Chat on new"]]);
      await manager.readNewChats();
      expect(events).toEqual(["observe:new"]);
    });
  });

  it("reads again a box whose kept chat is another thread's", async () => {
    await withChats(async ({ registry, events, recorded, carded, manager }) => {
      await claimedBox(registry, "reclaimed");
      carded.set("reclaimed", "thread-before");
      await manager.readNewChats();
      expect(events).toEqual(["observe:reclaimed"]);
      expect(recorded).toEqual([["reclaimed", "Chat on reclaimed"]]);
    });
  });

  it("waits a minute before reading again a box that showed no chat", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
      await withChats(async ({ registry, events, chatless, manager }) => {
        await claimedBox(registry, "early");
        chatless.add("early");
        await manager.readNewChats();
        vi.setSystemTime(new Date("2026-10-01T00:00:59.000Z"));
        await manager.readNewChats();
        expect(events).toEqual(["observe:early"]);
        vi.setSystemTime(new Date("2026-10-01T00:01:01.000Z"));
        await manager.readNewChats();
        expect(events).toEqual(["observe:early", "observe:early"]);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a pass that could not read the kept chats", async () => {
    await withChats(async ({ registry, events, failures, store, manager }) => {
      await claimedBox(registry, "new");
      store.broken = true;
      await manager.readNewChats();
      expect(events).toEqual([]);
      expect(failures).toEqual([
        { message: "new cloud box chats could not be read", cause: "database is locked" },
      ]);
    });
  });
});

describe("a cloud box's cleanup", () => {
  it("cancels the removal of a box whose chat is opened while its work is backed up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await withSqlRegistry(async (registry) => {
        const pausedAt = new Date("2026-03-01T12:00:00.000Z");
        await registry.register({
          leaseId: "lease",
          sandboxId: "sandbox",
          providerInstanceId: "codex",
          provider: "namespace",
          namespaceResource: {
            provider: "namespace",
            devboxId: "devbox",
            instanceId: "instance",
            region: "us",
            workspaceDir: "/workspace",
          },
          owner: { environmentId: "child", threadId: "thread" },
          now: pausedAt,
        });
        await registry.markPaused("lease", pausedAt);
        vi.setSystemTime(new Date("2026-03-09T00:00:00.000Z"));
        const { driver, calls } = setup();
        const manager = createEnvironmentControl([], driver, registry);
        const disposed: string[] = [];
        let opened: unknown;
        const read = async (leaseId: string) => {
          const lease = await registry.findById(leaseId);
          return lease ? { lease, thread: null } : null;
        };
        await createCleanupSweep({
          now: () => Date.now(),
          afterDays: async () => 7,
          candidates: async () =>
            (await registry.paused()).map((lease) => ({ lease, thread: null })),
          read,
          holdBox: async (sandboxId) => manager.holdBox(sandboxId, "clean"),
          backUpWork: async () => {
            opened = await manager.resume({
              leaseId: "lease",
              sandboxId: "sandbox",
              environmentId: EnvironmentId.make("child"),
            });
            return { kind: "clean" };
          },
          setKeep: registry.setKeep,
          sleep: manager.sleepBox,
          beginRemoval: manager.beginRemoval,
          dispose: async (leaseId) => {
            disposed.push(leaseId);
            return true;
          },
          log: () => {},
          warn: () => {},
        })();

        expect(opened).toEqual({
          kind: "refused",
          reason: "unknown",
          message:
            "This machine is being checked before cleanup. Cleanup is postponed; open it again in a few minutes.",
        });
        expect(disposed).toEqual([]);
        expect(calls).toEqual(["pause"]);
        expect(await registry.findById("lease")).toMatchObject({
          state: "paused",
          updatedAt: "2026-03-09T00:00:00.000Z",
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not promise to cancel a removal that has already started", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await withSqlRegistry(async (registry) => {
        const pausedAt = new Date("2026-03-01T12:00:00.000Z");
        await registry.register({
          leaseId: "lease",
          sandboxId: "sandbox",
          providerInstanceId: "codex",
          provider: "namespace",
          namespaceResource: {
            provider: "namespace",
            devboxId: "devbox",
            instanceId: "instance",
            region: "us",
            workspaceDir: "/workspace",
          },
          owner: { environmentId: "child", threadId: "thread" },
          now: pausedAt,
        });
        await registry.markPaused("lease", pausedAt);
        vi.setSystemTime(new Date("2026-03-09T00:00:00.000Z"));
        const { driver, calls } = setup();
        const manager = createEnvironmentControl([], driver, registry);
        const disposed: string[] = [];
        let opened: unknown;
        const read = async (leaseId: string) => {
          const lease = await registry.findById(leaseId);
          return lease ? { lease, thread: null } : null;
        };
        await createCleanupSweep({
          now: () => Date.now(),
          afterDays: async () => 7,
          candidates: async () =>
            (await registry.paused()).map((lease) => ({ lease, thread: null })),
          read,
          holdBox: async (sandboxId) => manager.holdBox(sandboxId, "clean"),
          backUpWork: async () => ({ kind: "clean" }),
          setKeep: registry.setKeep,
          sleep: manager.sleepBox,
          beginRemoval: manager.beginRemoval,
          dispose: async (leaseId) => {
            opened = await manager.resume({
              leaseId: "lease",
              sandboxId: "sandbox",
              environmentId: EnvironmentId.make("child"),
            });
            disposed.push(leaseId);
            return true;
          },
          log: () => {},
          warn: () => {},
        })();

        expect(opened).toEqual({
          kind: "refused",
          reason: "unknown",
          message: "Another workspace operation is in progress. Retry shortly.",
        });
        expect(disposed).toEqual(["lease"]);
        expect(calls).toEqual([]);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
