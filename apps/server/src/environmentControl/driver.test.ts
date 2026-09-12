import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { createCloudDriver } from "./driver.ts";
import type { EnvironmentControlConfig } from "./config.ts";

const sdk = vi.hoisted(() => ({
  getInfo: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  describe: vi.fn(),
}));
vi.mock("e2b", () => ({ Sandbox: { getInfo: sdk.getInfo, connect: sdk.connect } }));
vi.mock("@namespacelabs/sdk/auth", () => ({
  loadUserToken: async () => "token",
  fromBearerToken: () => "token",
}));
vi.mock("@namespacelabs/sdk/api", () => ({
  createClient: () => ({ fetch: sdk.fetch, describeInstance: sdk.describe }),
  createGlobalTransport: () => ({}),
  createRegionTransport: () => ({}),
}));
const target = {
  environmentId: EnvironmentId.make("cloud"),
  label: "Cloud",
  hostId: "host",
  operatorToken: "secret-token",
  machine: { provider: "e2b", sandboxId: "target", metadata: { owner: "test" } },
} satisfies EnvironmentControlConfig["targets"][number];
const config: EnvironmentControlConfig = {
  e2bApiKey: "secret-key",
  broker: {
    sandboxId: "broker",
    metadata: { owner: "test" },
    url: "https://controller.invalid",
    ingressKey: "secret-ingress",
  },
  targets: [target],
};
function info(state: "paused" | "running", sandboxId = "broker") {
  return { sandboxId, state, metadata: { owner: "test" }, lifecycle: { onTimeout: "pause" } };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
describe("cloud SDK and controller boundary", () => {
  it("does not silently route Namespace requests through E2B", async () => {
    const driver = createCloudDriver({
      ...config,
      provisioning: { namespace: { size: "m" } },
    });
    await expect(
      driver.provision({ provider: "namespace", providerInstanceId: "codex" }),
    ).rejects.toMatchObject({
      name: "ProvisionRefused",
      reason: "unsupported",
    });
    expect(sdk.connect).not.toHaveBeenCalled();
  });

  it("observes paused E2B and Namespace without any controller HTTP or resume", async () => {
    const http = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
    sdk.getInfo.mockResolvedValue(info("paused", "target"));
    sdk.fetch.mockResolvedValue({ devbox: { id: "devbox", volumeName: "volume" }, instanceId: "" });
    const driver = createCloudDriver(config);
    expect(await driver.observe(target)).toEqual({ kind: "stopped" });
    expect(
      await driver.observe({
        ...target,
        machine: {
          provider: "namespace",
          name: "name",
          devboxId: "devbox",
          volumeName: "volume",
          region: "region",
        },
      }),
    ).toEqual({ kind: "stopped" });
    expect(http).not.toHaveBeenCalled();
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.describe).not.toHaveBeenCalled();
  });
  it("refuses a changed owner or storage policy", async () => {
    const driver = createCloudDriver(config);
    for (const observation of [
      { ...info("paused", "target"), metadata: { owner: "other" } },
      { ...info("paused", "target"), lifecycle: { onTimeout: "kill" } },
    ]) {
      sdk.getInfo.mockResolvedValue(observation);
      await expect(driver.observe(target)).rejects.toThrow("ownership or persistence");
    }
    expect(sdk.connect).not.toHaveBeenCalled();
  });
  it("refuses unsupported old controllers without sending stop", async () => {
    sdk.getInfo.mockResolvedValue(info("running"));
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 401 }));
    expect(await createCloudDriver(config).stop(target, "target")).toEqual({
      kind: "refused",
      reason: "unsupported",
    });
    expect(http).toHaveBeenCalledTimes(1);
    expect(String(http.mock.calls[0]?.[0])).toContain("/capabilities");
    expect(http.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it("the HTTP boundary refuses a broker that became paused", async () => {
    sdk.getInfo.mockResolvedValue(info("paused"));
    const http = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected HTTP"));
    await expect(createCloudDriver(config).stop(target, "target")).rejects.toThrow(
      "Controller is paused",
    );
    expect(http).not.toHaveBeenCalled();
  });
  it("passes the observed instance to protocol2 stop and decodes the refusal", async () => {
    sdk.getInfo.mockResolvedValue(info("running"));
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ protocol: 2, manualStop: true }))
      .mockResolvedValueOnce(Response.json({ kind: "refused", reason: "busy" }));
    expect(await createCloudDriver(config).stop(target, "observed-instance")).toEqual({
      kind: "refused",
      reason: "busy",
    });
    expect(http.mock.calls[1]?.[1]?.body).toBe('{"instanceId":"observed-instance"}');
  });
});
