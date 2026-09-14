import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { createCloudDriver } from "./driver.ts";
import type { EnvironmentControlConfig } from "./config.ts";

const sdk = vi.hoisted(() => ({
  getInfo: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  describe: vi.fn(),
  issueToken: vi.fn().mockResolvedValue("local-session-token"),
  loadUserToken: vi.fn(),
  fromBearerToken: vi.fn(),
}));
vi.mock("e2b", () => ({ Sandbox: { getInfo: sdk.getInfo, connect: sdk.connect } }));
vi.mock("@namespacelabs/sdk/auth", () => ({
  loadUserToken: sdk.loadUserToken.mockImplementation(async () => ({ issueToken: sdk.issueToken })),
  fromBearerToken: sdk.fromBearerToken.mockImplementation((token: string) => ({
    issueToken: async () => token,
  })),
}));
vi.mock("@namespacelabs/sdk/api", () => ({
  createClient: (
    _service: unknown,
    transport: { tokenSource?: { issueToken: (minimum: number) => Promise<string> } },
  ) => ({
    fetch: async (...args: unknown[]) => {
      await transport.tokenSource?.issueToken(60_000);
      return sdk.fetch(...args);
    },
    describeInstance: sdk.describe,
  }),
  createGlobalTransport: (options: unknown) => options,
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
  it("resumes the same E2B sandbox even with the legacy inherited kill timeout", async () => {
    const retained = {
      sandboxId: "retained",
      metadata: { purpose: "t3-environment", account: "codex" },
      lifecycle: { onTimeout: "kill" },
    };
    sdk.getInfo
      .mockResolvedValueOnce({ ...retained, state: "paused" })
      .mockResolvedValueOnce({ ...retained, state: "running" });
    sdk.connect.mockResolvedValue({ sandboxId: "retained" });
    expect(
      await createCloudDriver(config).resume({
        sandboxId: "retained",
        providerInstanceId: "codex",
        environmentId: "child",
      }),
    ).toEqual({});
    expect(sdk.connect).toHaveBeenCalledWith(
      "retained",
      expect.objectContaining({ timeoutMs: 3_600_000 }),
    );
  });
  it("refuses a provisioned sandbox owned by another account", async () => {
    sdk.getInfo.mockResolvedValue({
      sandboxId: "retained",
      state: "paused",
      metadata: { purpose: "t3-environment", account: "other" },
    });
    await expect(
      createCloudDriver(config).resume({
        sandboxId: "retained",
        providerInstanceId: "codex",
        environmentId: "child",
      }),
    ).rejects.toThrow("ownership");
    expect(sdk.connect).not.toHaveBeenCalled();
  });
  it("does not report a resumed sandbox until it is running", async () => {
    sdk.getInfo.mockResolvedValue({
      sandboxId: "retained",
      state: "paused",
      metadata: { purpose: "t3-environment", account: "codex" },
    });
    await expect(
      createCloudDriver(config).resume({
        sandboxId: "retained",
        providerInstanceId: "codex",
        environmentId: "child",
      }),
    ).rejects.toThrow("did not resume");
  });
  it("does not silently route Namespace requests through E2B", async () => {
    const driver = createCloudDriver({
      ...config,
      provisioning: { namespace: { size: "m" } },
    });
    await expect(
      driver.provision({ provider: "namespace", providerInstanceId: "codex" }),
    ).rejects.toMatchObject({
      name: "ProvisionRefused",
      reason: "unconfigured",
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

  it("pauses an E2B sandbox without killing it", async () => {
    const pause = vi.fn().mockResolvedValue(true);
    sdk.connect.mockResolvedValue({ pause });
    await createCloudDriver(config).pause({ sandboxId: "target" });
    expect(sdk.connect).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({ timeoutMs: 90_000 }),
    );
    expect(pause).toHaveBeenCalledTimes(1);
  });
});

it("loads local Namespace credentials lazily and retries after a failed load", async () => {
  const driver = createCloudDriver(config);
  expect(sdk.loadUserToken).not.toHaveBeenCalled();
  const namespaceTarget = {
    ...target,
    machine: {
      provider: "namespace" as const,
      name: "name",
      devboxId: "devbox",
      volumeName: "volume",
      region: "region",
    },
  };
  sdk.loadUserToken.mockRejectedValueOnce(new Error("not logged in"));
  await expect(driver.observe(namespaceTarget)).rejects.toThrow("not logged in");
  sdk.fetch.mockResolvedValue({ devbox: { id: "devbox", volumeName: "volume" }, instanceId: "" });
  await expect(driver.observe(namespaceTarget)).resolves.toEqual({ kind: "stopped" });
  expect(sdk.issueToken).toHaveBeenCalledWith(60_000, undefined);
  expect(sdk.fromBearerToken).not.toHaveBeenCalled();
});

it("uses configured Namespace credentials without loading the local nsc session", async () => {
  sdk.fetch.mockResolvedValue({ devbox: { id: "devbox", volumeName: "volume" }, instanceId: "" });
  const driver = createCloudDriver({ ...config, namespaceToken: "configured-token" });
  await expect(
    driver.observe({
      ...target,
      machine: {
        provider: "namespace",
        name: "name",
        devboxId: "devbox",
        volumeName: "volume",
        region: "region",
      },
    }),
  ).resolves.toEqual({ kind: "stopped" });
  expect(sdk.fromBearerToken).toHaveBeenCalledWith("configured-token");
  expect(sdk.loadUserToken).not.toHaveBeenCalled();
});
