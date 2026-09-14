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
  it("reactivates a Namespace lease with its same owner, home, volume and proxy", async () => {
    const registry = await makeRegistry();
    const namespaceResource = {
      provider: "namespace" as const,
      devboxId: "devbox",
      instanceId: "old",
      region: "us",
      workspaceDir: "/Volumes/devbox/work",
      homeDir: "/Volumes/devbox/.t3-home",
    };
    const namespaceProxy = { proxyId: "proxy", proxyOrigin: "http://127.0.0.1:40001" };
    await registry.register({
      leaseId: "lease",
      sandboxId: "devbox",
      providerInstanceId: "codex",
      namespaceResource,
      namespaceProxy,
    });
    await registry.claim({
      leaseId: "lease",
      owner: { environmentId: "child", threadId: "thread" },
    });
    await registry.markPaused("lease");
    const input = {
      leaseId: "lease",
      namespaceResource: { ...namespaceResource, instanceId: "new" },
      namespaceProxy,
      now: new Date("2026-09-13T00:00:00.000Z"),
    };
    const resumed = await registry.markActive(input);
    expect(resumed).toMatchObject({
      leaseId: "lease",
      sandboxId: "devbox",
      state: "active",
      namespaceResource: { ...namespaceResource, instanceId: "new" },
      namespaceProxy,
      owner: { environmentId: "child", threadId: "thread" },
      expiresAt: "2026-09-13T00:15:00.000Z",
    });
    expect(await registry.markActive(input)).toEqual(resumed);
    await expect(
      registry.markActive({
        ...input,
        namespaceProxy: { ...namespaceProxy, proxyOrigin: "http://127.0.0.1:40002" },
      }),
    ).rejects.toThrow("identity conflict");
    await registry.beginRelease({ leaseId: "lease", sandboxId: "devbox" });
    expect(await registry.markActive(input)).toBeNull();
    await registry.markDisposed("lease");
    expect(await registry.markActive(input)).toBeNull();
    await registry.markPaused("lease");
    expect(await registry.findBySandbox("devbox")).toMatchObject({ state: "disposed" });
  });
  it("persists missing workspaces without making them eligible for heartbeat, resume, or pause", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lease-"));
    temporaryDirectories.push(directory);
    const path = NodePath.join(directory, "leases.json");
    const registry = createProvisionedLeaseRegistry(path);
    await registry.register({
      leaseId: "lease",
      sandboxId: "sandbox",
      providerInstanceId: "codex",
    });
    await registry.claim({
      leaseId: "lease",
      owner: { environmentId: "child", threadId: "thread" },
    });
    await registry.markMissing("lease");
    const reopened = createProvisionedLeaseRegistry(path);
    expect(await reopened.findById("lease")).toMatchObject({ state: "missing" });
    expect(await reopened.touch("lease")).toBeNull();
    expect(await reopened.markActive({ leaseId: "lease" })).toBeNull();
    await reopened.markPaused("lease");
    expect(await reopened.findBySandbox("sandbox")).toMatchObject({ state: "missing" });
    expect(await reopened.expired(new Date("2100-01-01"))).toEqual([]);
    expect(await reopened.beginRelease({ leaseId: "lease", sandboxId: "sandbox" })).toBe("started");
    await reopened.markDisposed("lease");
    await reopened.markMissing("lease");
    expect(await reopened.findById("lease")).toMatchObject({ state: "disposed" });
  });
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

  it("persists the manager proxy identity across reopening", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lease-"));
    temporaryDirectories.push(directory);
    const path = NodePath.join(directory, "leases.json");
    await createProvisionedLeaseRegistry(path).register({
      leaseId: "lease-proxy",
      sandboxId: "sandbox-proxy",
      providerInstanceId: "codex",
      namespaceProxy: { proxyId: "proxy-1", proxyOrigin: "https://proxy.example" },
    });
    expect(await createProvisionedLeaseRegistry(path).findBySandbox("sandbox-proxy")).toMatchObject(
      {
        namespaceProxy: { proxyId: "proxy-1", proxyOrigin: "https://proxy.example" },
      },
    );
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
    expect(await registry.expired(new Date("2026-01-01T00:14:59.000Z"))).toHaveLength(0);
    expect(await registry.expired(new Date("2026-01-01T00:15:01.000Z"))).toHaveLength(1);
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
    expect(await registry.expired(new Date("2026-01-01T00:14:59.000Z"))).toHaveLength(0);
    expect(await registry.expired(new Date("2026-01-01T00:15:01.000Z"))).toHaveLength(1);
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
    expect(await registry.touch("lease-1", new Date("2026-01-01T00:15:00.000Z"))).toMatchObject({
      expiresAt: "2026-01-01T00:30:00.000Z",
    });
    expect(await registry.touch("missing")).toBeNull();
  });
});

it.each([undefined, 3001])("round-trips Namespace service port %s", async (t3Port) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-port-"));
  temporaryDirectories.push(directory);
  const path = NodePath.join(directory, "leases.json");
  const registry = createProvisionedLeaseRegistry(path);
  await registry.register({
    leaseId: "port-lease",
    sandboxId: "devbox",
    providerInstanceId: "codex",
    namespaceResource: {
      provider: "namespace",
      devboxId: "devbox",
      instanceId: "instance",
      region: "iad",
      workspaceDir: "/Volumes/devbox/project",
      ...(t3Port === undefined ? {} : { t3Port }),
    },
  });
  const restored = await createProvisionedLeaseRegistry(path).findById("port-lease");
  expect(restored?.namespaceResource?.t3Port).toBe(t3Port);
  expect(JSON.parse(await NodeFSP.readFile(path, "utf8"))[0].namespaceResource.t3Port).toBe(t3Port);
});

it.each([0, -1, 65536, 3001.5, Number.NaN])(
  "rejects invalid Namespace service port %s before persisting",
  async (t3Port) => {
    const registry = await makeRegistry();
    await expect(
      registry.register({
        leaseId: "invalid-port",
        sandboxId: "devbox",
        providerInstanceId: "codex",
        namespaceResource: {
          provider: "namespace",
          devboxId: "devbox",
          instanceId: "instance",
          region: "iad",
          workspaceDir: "/Volumes/devbox/project",
          t3Port,
        },
      }),
    ).rejects.toThrow();
    expect(await registry.findById("invalid-port")).toBeNull();
  },
);
