import { describe, expect, it, vi } from "vite-plus/test";
import {
  disposeNamespace,
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
    destroyInstance: vi.fn(async () => {
      calls.push("destroy");
    }),
    expireDevbox: vi.fn(async () => {
      calls.push("expire");
    }),
  };
}

describe("Namespace disposal", () => {
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
