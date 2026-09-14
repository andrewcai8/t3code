import { describe, expect, it, vi } from "vite-plus/test";
import {
  disposeNamespace,
  provisionNamespace,
  type NamespaceResource,
  type NamespaceRunner,
} from "./namespaceProvisioner.ts";

const resource: NamespaceResource = {
  provider: "namespace",
  devboxId: "dbx-1",
  instanceId: "ins-1",
  region: "us",
  workspaceDir: "/Users/runner/workspaces",
};

function runner(): NamespaceRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resume: vi.fn(async () => ({ resource, upstreamOrigin: "https://retained.example" })),
    create: vi.fn(async () => {
      calls.push("create");
      return resource;
    }),
    bootstrap: vi.fn(async () => {
      calls.push("bootstrap");
    }),
    expose: vi.fn(async () => {
      calls.push("expose");
      return "https://client.example/pair#token=pairing-token";
    }),
    destroyInstance: vi.fn(async () => {
      calls.push("destroy");
    }),
    expireDevbox: vi.fn(async () => {
      calls.push("expire");
    }),
  };
}

describe("Namespace provisioning seam", () => {
  it("creates, bootstraps, then exposes the client endpoint", async () => {
    const r = runner();
    await expect(
      provisionNamespace(r, { size: "m", providerInstanceId: "codex" }),
    ).resolves.toEqual({
      resource,
      pairingUrl: "https://client.example/pair#token=pairing-token",
      projectDir: "/Users/runner/workspaces",
    });
    expect(r.calls).toEqual(["create", "bootstrap", "expose"]);
  });

  it("cleans up a Devbox when bootstrap fails", async () => {
    const r = runner();
    vi.spyOn(r, "bootstrap").mockImplementation(async () => {
      r.calls.push("bootstrap");
      throw new Error("bootstrap failed");
    });
    await expect(provisionNamespace(r, { size: "m", providerInstanceId: "codex" })).rejects.toThrow(
      "bootstrap failed",
    );
    expect(r.calls).toEqual(["create", "bootstrap", "destroy", "expire"]);
  });

  it("destroys the active instance before expiring the Devbox", async () => {
    const r = runner();
    await disposeNamespace(r, resource);
    expect(r.calls).toEqual(["destroy", "expire"]);
  });

  it("treats provider NotFound cleanup as already disposed", async () => {
    const r = runner();
    vi.spyOn(r, "destroyInstance").mockImplementation(async () => {
      throw new Error("404 not found");
    });
    await expect(disposeNamespace(r, resource)).resolves.toBeUndefined();
    expect(r.calls).toEqual(["expire"]);
  });
});
