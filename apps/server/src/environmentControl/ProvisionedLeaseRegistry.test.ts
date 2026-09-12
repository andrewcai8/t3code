// @effect-diagnostics nodeBuiltinImport:off - these tests use a temporary filesystem boundary.
// @effect-diagnostics globalDate:off - these tests use fixed timestamps.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  createProvisionedLeaseRegistry,
  type ProvisionedLeaseRegistry,
} from "./ProvisionedLeaseRegistry.ts";

const temporaryDirectories: string[] = [];

async function makeRegistry(): Promise<ProvisionedLeaseRegistry> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lease-"));
  temporaryDirectories.push(directory);
  return createProvisionedLeaseRegistry(NodePath.join(directory, "leases.json"));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProvisionedLeaseRegistry", () => {
  it("persists a lease and allows the same owner to claim it after reopening", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lease-"));
    temporaryDirectories.push(directory);
    const path = NodePath.join(directory, "leases.json");
    const first = createProvisionedLeaseRegistry(path);
    const created = await first.register({
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      providerInstanceId: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(created.state).toBe("active");

    const reopened = createProvisionedLeaseRegistry(path);
    expect(
      await reopened.claim({
        leaseId: "lease-1",
        owner: { environmentId: "remote", threadId: "thread-1" },
      }),
    ).toMatchObject({
      sandboxId: "sandbox-1",
      owner: { environmentId: "remote", threadId: "thread-1" },
    });
  });

  it("rejects a different owner and makes release idempotent", async () => {
    const registry = await makeRegistry();
    await registry.register({
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      providerInstanceId: "codex",
    });
    expect(
      await registry.claim({
        leaseId: "lease-1",
        owner: { environmentId: "remote", threadId: "thread-1" },
      }),
    ).not.toBeNull();
    expect(
      await registry.claim({
        leaseId: "lease-1",
        owner: { environmentId: "remote", threadId: "thread-2" },
      }),
    ).toBeNull();
    expect(await registry.beginRelease({ leaseId: "lease-1", sandboxId: "sandbox-1" })).toBe(
      "started",
    );
    expect(await registry.beginRelease({ leaseId: "lease-1", sandboxId: "sandbox-1" })).toBe(
      "busy",
    );
    await registry.markDisposed("lease-1");
    expect(await registry.beginRelease({ leaseId: "lease-1", sandboxId: "sandbox-1" })).toBe(
      "disposed",
    );
  });

  it("treats owner fields as structural and rejects lease identity conflicts", async () => {
    const registry = await makeRegistry();
    await registry.register({
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      providerInstanceId: "codex",
    });
    expect(
      await registry.claim({
        leaseId: "lease-1",
        owner: { threadId: "thread-1", environmentId: "remote" },
      }),
    ).not.toBeNull();
    await expect(
      registry.register({
        leaseId: "lease-1",
        sandboxId: "sandbox-2",
        providerInstanceId: "codex",
      }),
    ).rejects.toThrow("identity conflict");
  });

  it("returns leases whose expiry has passed", async () => {
    const registry = await makeRegistry();
    await registry.register({
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      providerInstanceId: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(await registry.expired(new Date("2026-01-01T01:00:01.000Z"))).toHaveLength(1);
  });

  it("expires a claimed lease after its heartbeat deadline", async () => {
    const registry = await makeRegistry();
    await registry.register({
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      providerInstanceId: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await registry.claim({
      leaseId: "lease-1",
      owner: { environmentId: "remote", threadId: "thread-1" },
    });
    expect(await registry.expired(new Date("2026-01-01T01:00:01.000Z"))).toHaveLength(1);
  });

  it("renews a claimed lease", async () => {
    const registry = await makeRegistry();
    await registry.register({
      leaseId: "lease-1",
      sandboxId: "sandbox-1",
      providerInstanceId: "codex",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    await registry.claim({
      leaseId: "lease-1",
      owner: { environmentId: "remote", threadId: "thread-1" },
    });
    expect(await registry.touch("lease-1", new Date("2026-01-01T01:00:00.000Z"))).toMatchObject({
      expiresAt: "2026-01-01T02:00:00.000Z",
    });
    expect(await registry.touch("missing")).toBeNull();
  });
});
