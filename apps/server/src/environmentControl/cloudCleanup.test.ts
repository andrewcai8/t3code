// @effect-diagnostics globalDate:off - fixed timestamps exercise cleanup times.
import { describe, expect, it } from "vite-plus/test";

import { cleanupPlan, createCleanupSweep, type CleanupCandidate } from "./cloudCleanup.ts";
import type { LeaseKeep, ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";
import type { WorkspaceBackup } from "./workspaceBackup.ts";

const PAUSED_AT = "2026-03-01T12:00:00.000Z";
const devbox = {
  provider: "namespace",
  devboxId: "devbox-1",
  instanceId: "instance-1",
  region: "us",
  workspaceDir: "/workspace",
} as const;

const lease = (overrides: Partial<ProvisionedLease> = {}): ProvisionedLease => ({
  leaseId: "lease-1",
  sandboxId: "sandbox-1",
  provider: "namespace",
  namespaceResource: devbox,
  providerInstanceId: "codex",
  state: "paused",
  owner: { environmentId: "env-1", threadId: "thread-1" },
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: PAUSED_AT,
  expiresAt: PAUSED_AT,
  ...overrides,
});
/** A lease with no Devbox: an E2B sandbox or an instance-engine chat. */
const withoutDevbox = (overrides: Partial<ProvisionedLease> = {}): ProvisionedLease => {
  const { namespaceResource: _devbox, ...rest } = lease(overrides);
  return rest;
};
const settled = (settledAt: string) => ({
  id: "thread-1",
  settledOverride: "settled" as const,
  settledAt,
});

describe("cleanupPlan", () => {
  it.each([
    {
      name: "removes an idle paused devbox the cleanup days after its pause",
      input: { lease: lease(), thread: null, afterDays: 7 },
      plan: { kind: "scheduled", at: "2026-03-08T12:00:00.000Z", reason: "idle" },
    },
    {
      name: "removes a chat settled before its pause an hour after the pause",
      input: { lease: lease(), thread: settled("2026-03-01T09:00:00.000Z"), afterDays: 7 },
      plan: { kind: "scheduled", at: "2026-03-01T13:00:00.000Z", reason: "settled" },
    },
    {
      name: "counts the settle hour from a settle after the pause",
      input: { lease: lease(), thread: settled("2026-03-02T00:00:00.000Z"), afterDays: 7 },
      plan: { kind: "scheduled", at: "2026-03-02T01:00:00.000Z", reason: "settled" },
    },
    {
      name: "ignores the settle of a thread that no longer owns the box",
      input: {
        lease: lease(),
        thread: { ...settled("2026-03-01T09:00:00.000Z"), id: "thread-2" },
        afterDays: 7,
      },
      plan: { kind: "scheduled", at: "2026-03-08T12:00:00.000Z", reason: "idle" },
    },
    {
      name: "never cleans an E2B sandbox",
      input: { lease: withoutDevbox({ provider: "e2b" }), thread: null, afterDays: 7 },
      plan: null,
    },
    {
      name: "never cleans an instance-engine chat, which has no devbox",
      input: { lease: withoutDevbox(), thread: null, afterDays: 7 },
      plan: null,
    },
    {
      name: "leaves an awake devbox alone",
      input: { lease: lease({ state: "active" }), thread: null, afterDays: 7 },
      plan: null,
    },
    {
      name: "reports a devbox its owner kept",
      input: { lease: lease({ keep: "user" }), thread: null, afterDays: 7 },
      plan: { kind: "kept", reason: "user" },
    },
    {
      name: "reports a kept devbox even while it is awake",
      input: {
        lease: lease({ state: "active", keep: "unsaved-work" }),
        thread: null,
        afterDays: 7,
      },
      plan: { kind: "kept", reason: "unsaved-work" },
    },
    {
      name: "keeps every devbox when cleanup is off",
      input: { lease: lease(), thread: settled("2026-03-01T09:00:00.000Z"), afterDays: null },
      plan: null,
    },
  ])("$name", ({ input, plan }) => {
    expect(cleanupPlan(input)).toEqual(plan);
  });
});

type FakeBox = { lease: ProvisionedLease; awake: boolean; locked: boolean };

const HOUR_MS = 3_600_000;

function fakeHost(
  leases: ReadonlyArray<ProvisionedLease>,
  backup: (box: FakeBox) => WorkspaceBackup | Promise<WorkspaceBackup>,
) {
  const boxes = new Map(
    leases.map((item) => [item.leaseId, { lease: item, awake: false, locked: false }]),
  );
  const settings: { now: number; afterDays: number | null } = {
    now: Date.parse("2026-03-09T00:00:00.000Z"),
    afterDays: 7,
  };
  const candidate = (box: FakeBox): CleanupCandidate => ({ lease: box.lease, thread: null });
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  let backups = 0;
  const ports = {
    now: () => settings.now,
    afterDays: async () => settings.afterDays,
    candidates: async () => [...boxes.values()].map(candidate),
    read: async (leaseId: string) => {
      const box = boxes.get(leaseId);
      return box ? candidate(box) : null;
    },
    holdBox: async (sandboxId: string) => {
      const box = [...boxes.values()].find((item) => item.lease.sandboxId === sandboxId);
      if (!box || box.locked) return null;
      box.locked = true;
      return () => {
        box.locked = false;
      };
    },
    beginRemoval: () => {},
    backUpWork: async (target: ProvisionedLease) => {
      const box = boxes.get(target.leaseId)!;
      box.awake = true;
      backups += 1;
      return backup(box);
    },
    setKeep: async (leaseId: string, keep: LeaseKeep | null) => {
      const box = boxes.get(leaseId)!;
      const { keep: _previous, ...rest } = box.lease;
      box.lease = keep === null ? rest : { ...rest, keep };
    },
    sleep: async (target: ProvisionedLease) => {
      boxes.get(target.leaseId)!.awake = false;
    },
    dispose: async (leaseId: string) => {
      const box = boxes.get(leaseId)!;
      box.lease = { ...box.lease, state: "disposed" };
      box.awake = false;
      return true;
    },
    log: (message: string, fields: Record<string, unknown>) => logs.push({ message, fields }),
    warn: (message: string, fields: Record<string, unknown>) => warnings.push({ message, fields }),
  };
  const state = (leaseId: string) => {
    const box = boxes.get(leaseId)!;
    return {
      state: box.lease.state,
      keep: box.lease.keep ?? null,
      awake: box.awake,
      locked: box.locked,
    };
  };
  return { ports, boxes, settings, state, logs, warnings, backups: () => backups };
}

const asleep = { state: "paused", keep: null, awake: false, locked: false };

describe("createCleanupSweep", () => {
  it("removes a due box whose work is backed up", async () => {
    const host = fakeHost([lease()], () => ({ kind: "saved", branches: ["t3-backup/lease-1"] }));
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual({
      state: "disposed",
      keep: null,
      awake: false,
      locked: false,
    });
    expect(host.logs).toEqual([
      {
        message: "cloud box cleaned up",
        fields: { leaseId: "lease-1", reason: "idle", branches: ["t3-backup/lease-1"] },
      },
    ]);
  });

  it("keeps and sleeps a due box whose work could not be backed up", async () => {
    const host = fakeHost([lease()], () => ({ kind: "unsaved", reason: "no origin remote" }));
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual({ ...asleep, keep: "unsaved-work" });
    expect(host.warnings).toEqual([
      {
        message: "cloud box kept: its work could not be backed up",
        fields: { leaseId: "lease-1", reason: "no origin remote" },
      },
    ]);
  });

  it("sleeps a box whose backup failed outright and tries it again six hours later", async () => {
    const host = fakeHost([lease()], () => {
      throw new Error("exec timed out");
    });
    const sweep = createCleanupSweep(host.ports);
    await sweep();
    expect(host.state("lease-1")).toEqual(asleep);
    await sweep();
    expect(host.backups()).toBe(1);
    host.settings.now += 6 * HOUR_MS;
    await sweep();
    expect(host.backups()).toBe(2);
    expect(host.state("lease-1")).toEqual(asleep);
  });

  it("puts a box back to sleep on the next pass when its sleep failed", async () => {
    const host = fakeHost([lease()], () => ({ kind: "unsaved", reason: "no origin remote" }));
    const sleep = host.ports.sleep;
    let failures = 1;
    host.ports.sleep = async (target) => {
      if (failures-- > 0) throw new Error("Namespace unreachable");
      return sleep(target);
    };
    const sweep = createCleanupSweep(host.ports);
    await sweep();
    expect(host.state("lease-1").awake).toBe(true);
    await sweep();
    expect(host.state("lease-1")).toEqual({ ...asleep, keep: "unsaved-work" });
  });

  it("sleeps a box whose removal is still pending", async () => {
    const host = fakeHost([lease()], () => ({ kind: "clean" }));
    host.ports.dispose = async () => false;
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual(asleep);
  });

  it("sleeps a box without removing it when cleanup is turned off during its backup", async () => {
    const host = fakeHost([lease()], () => {
      host.settings.afterDays = null;
      return { kind: "clean" };
    });
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual(asleep);
  });

  it("skips a box another operation holds", async () => {
    const host = fakeHost([lease()], () => ({ kind: "clean" }));
    host.boxes.get("lease-1")!.locked = true;
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual({ ...asleep, locked: true });
  });

  it("sleeps a box its owner kept during its backup, without removing it", async () => {
    const host = fakeHost([lease()], (box) => {
      box.lease = { ...box.lease, keep: "user" };
      return { kind: "clean" };
    });
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual({ ...asleep, keep: "user" });
  });

  it("sleeps a box whose chat was opened during its backup, without removing it", async () => {
    const host = fakeHost([lease()], (box) => {
      box.lease = { ...box.lease, updatedAt: "2026-03-08T23:00:00.000Z" };
      return { kind: "clean" };
    });
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual(asleep);
  });

  it("leaves a box that is not yet due untouched", async () => {
    const host = fakeHost([lease({ updatedAt: "2026-03-05T00:00:00.000Z" })], () => ({
      kind: "clean",
    }));
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual(asleep);
    expect(host.backups()).toBe(0);
  });

  it("sleeps a box that fails to dispose and goes on to the next", async () => {
    const host = fakeHost([lease(), lease({ leaseId: "lease-2", sandboxId: "sandbox-2" })], () => ({
      kind: "clean",
    }));
    const dispose = host.ports.dispose;
    host.ports.dispose = async (leaseId) => {
      if (leaseId === "lease-1") throw new Error("Namespace refused");
      return dispose(leaseId);
    };
    await createCleanupSweep(host.ports)();
    expect(host.state("lease-1")).toEqual(asleep);
    expect(host.state("lease-2").state).toBe("disposed");
  });
});
