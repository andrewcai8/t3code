// @effect-diagnostics nodeBuiltinImport:off - tests use isolated temporary configuration files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { readConfig, resolveControlConfigPath } from "./config.ts";

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
    expect((await readConfig(path)).provisioning?.namespace?.prepareCommands).toBeUndefined();
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        ...config,
        provisioning: { namespace: { size: "m", prepareCommands: ["./prepare-native.sh"] } },
      }),
    );
    expect((await readConfig(path)).provisioning?.namespace?.prepareCommands).toEqual([
      "./prepare-native.sh",
    ]);
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

it("resolves cloud control configuration from the state directory by default", async () => {
  const seen: string[] = [];
  const path = await resolveControlConfigPath({
    stateDir: "/state",
    exists: async (candidate) => {
      seen.push(candidate);
      return true;
    },
  });
  expect(path).toBe("/state/environment-control.json");
  expect(seen).toEqual(["/state/environment-control.json"]);
});

it("reports no cloud control configuration rather than failing when the default is absent", async () => {
  expect(await resolveControlConfigPath({ stateDir: "/state", exists: async () => false })).toBe(
    null,
  );
});

it("falls back to the machine-level configuration for isolated state directories", async () => {
  const fallback = "/home/andrew/.t3/environment-control.json";
  const seen: string[] = [];
  const path = await resolveControlConfigPath({
    stateDir: "/worktree/.t3/userdata",
    fallback,
    exists: async (candidate) => {
      seen.push(candidate);
      return candidate === fallback;
    },
  });
  expect(path).toBe(fallback);
  expect(seen).toEqual(["/worktree/.t3/userdata/environment-control.json", fallback]);
});

it("keeps an explicit path even when it is missing, so the mistake surfaces", async () => {
  // Naming a file that does not exist is a misconfiguration and has to fail
  // loudly downstream; reporting "no cloud controls" would hide it.
  expect(
    await resolveControlConfigPath({
      explicit: "/elsewhere/control.json",
      stateDir: "/state",
      exists: async () => false,
    }),
  ).toBe("/elsewhere/control.json");
});

it("treats a whitespace-only override as unset", async () => {
  expect(
    await resolveControlConfigPath({
      explicit: "   ",
      stateDir: "/state",
      exists: async () => false,
    }),
  ).toBe(null);
});
