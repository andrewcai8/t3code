// @effect-diagnostics nodeBuiltinImport:off - tests use isolated temporary configuration files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { readConfig } from "./config.ts";

it("loads private configuration and rejects ambiguous target mappings", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cloud-config-"));
  const path = NodePath.join(directory, "config.json");
  const target = {
    environmentId: "cloud",
    label: "Cloud",
    hostId: "host",
    operatorToken: "x".repeat(32),
    machine: { provider: "e2b", sandboxId: "sandbox", metadata: { owner: "test" } },
  };
  const config = {
    e2bApiKey: "test-key",
    broker: {
      sandboxId: "broker",
      metadata: { owner: "test" },
      url: "https://controller.invalid",
      ingressKey: "test-ingress",
    },
    targets: [target],
  };
  try {
    await NodeFSP.writeFile(path, JSON.stringify(config), { mode: 0o600 });
    expect((await readConfig(path)).targets[0]?.environmentId).toBe("cloud");
    await NodeFSP.writeFile(path, JSON.stringify({ ...config, targets: [target, target] }));
    await expect(readConfig(path)).rejects.toThrow("Duplicate managed environment");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({ ...config, broker: { ...config.broker, metadata: {} } }),
    );
    await expect(readConfig(path)).rejects.toThrow("ownership metadata required");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
