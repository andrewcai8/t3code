import { describe, expect, it } from "vite-plus/test";
import { makeNamespaceBootstrapPlan } from "./namespaceBootstrap.ts";

describe("makeNamespaceBootstrapPlan", () => {
  it("returns ordered T3, device tooling, serve, and pairing commands", () => {
    const plan = makeNamespaceBootstrapPlan({
      workspaceDir: "/Users/runner/work space",
      t3Version: "0.0.40",
      port: 4310,
      deviceToolchainInstallDir: "/Users/runner/device tools",
      projectDir: "/Users/runner/work space/project",
      pairingLabel: "namespace mac",
      expoDeviceHubVersion: "1.2.3",
      agentDeviceVersion: "4.5.6",
    });

    expect(plan.commands).toEqual([
      "mkdir -p '/Users/runner/work space'",
      "npm install --prefix '/Users/runner/work space' --no-save 't3@0.0.40'",
      "npm install --prefix '/Users/runner/device tools' --no-save 'expo-device-hub@1.2.3' 'agent-device@4.5.6'",
      "cd '/Users/runner/work space/project' && '/Users/runner/work space/node_modules/.bin/t3' serve --no-browser --host 0.0.0.0 --port 4310",
    ]);
    expect(plan.pairingCommand).toBe(
      "cd '/Users/runner/work space/project' && '/Users/runner/work space/node_modules/.bin/t3' pair --ttl 12h --label 'namespace mac'",
    );
  });

  it("quotes embedded single quotes and never includes credentials", () => {
    const plan = makeNamespaceBootstrapPlan({
      workspaceDir: "/tmp/runner's workspace",
      t3Version: "0.0.40",
      port: 3000,
      deviceToolchainInstallDir: "/tmp/tools",
      projectDir: "/tmp/project",
      pairingLabel: "chat's Mac",
      expoDeviceHubVersion: "1.0.0",
      agentDeviceVersion: "2.0.0",
    });

    const text = [...plan.commands, plan.pairingCommand].join("\n");
    expect(text).toContain("'/tmp/runner'\\''s workspace'");
    expect(text).toContain("'chat'\\''s Mac'");
    expect(text).not.toMatch(/token|secret|api[_-]?key|password/i);
  });
});
