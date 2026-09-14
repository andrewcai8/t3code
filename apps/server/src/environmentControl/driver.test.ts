import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { SandboxNotFoundError } from "e2b";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { createCloudDriver, ProvisionedSandboxMissing } from "./driver.ts";
import type { EnvironmentControlConfig } from "./config.ts";

const sdk = vi.hoisted(() => ({
  getInfo: vi.fn(),
  setTimeout: vi.fn(),
  create: vi.fn(),
  readFile: vi.fn(),
  connect: vi.fn(),
  fetch: vi.fn(),
  describe: vi.fn(),
  issueToken: vi.fn().mockResolvedValue("local-session-token"),
  loadUserToken: vi.fn(),
  fromBearerToken: vi.fn(),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: sdk.readFile,
}));
vi.mock("e2b", async (importOriginal) => ({
  ...(await importOriginal<typeof import("e2b")>()),
  Sandbox: {
    getInfo: sdk.getInfo,
    connect: sdk.connect,
    setTimeout: sdk.setTimeout,
    create: sdk.create,
  },
}));
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
  it("creates fork parents with a persistent timeout and cleans them up when a fork fails", async () => {
    sdk.readFile.mockResolvedValue("{}\n");
    const parent = {
      fork: vi.fn().mockRejectedValue(new Error("fork unavailable")),
      kill: vi.fn().mockResolvedValue(undefined),
    };
    sdk.create.mockResolvedValue(parent);
    await expect(
      createCloudDriver({ ...config, provisioning: { templateId: "template" } }, async () => ({
        kind: "codex",
        instanceId: ProviderInstanceId.make("codex"),
        environment: [],
        credential: { kind: "environment" },
      })).provision({
        provider: "e2b",
        providerInstanceId: "codex",
      }),
    ).rejects.toThrow("fork unavailable");
    expect(sdk.create).toHaveBeenCalledWith(
      "template",
      expect.objectContaining({
        lifecycle: { onTimeout: "pause", autoResume: false },
      }),
    );
    expect(parent.fork).toHaveBeenCalledWith({ count: 1, timeoutMs: 6 * 3_600_000 });
    expect(parent.kill).toHaveBeenCalledTimes(1);
  });
  it("renews an owned running workspace without connecting or shortening a longer deadline", async () => {
    const retained = {
      sandboxId: "retained",
      state: "running",
      metadata: { purpose: "t3-environment", account: "codex" },
    };
    sdk.getInfo
      .mockResolvedValueOnce({
        ...retained,
        endAt: DateTime.toDateUtc(DateTime.makeUnsafe("2000-01-01T00:00:00Z")),
      })
      .mockResolvedValueOnce({
        ...retained,
        endAt: DateTime.toDateUtc(DateTime.makeUnsafe("2100-01-01T00:00:00Z")),
      });
    const driver = createCloudDriver(config);
    const input = { sandboxId: "retained", providerInstanceId: "codex" };
    expect(await driver.renew(input)).toBe("running");
    expect(await driver.renew(input)).toBe("running");
    expect(sdk.setTimeout).toHaveBeenCalledExactlyOnceWith(
      "retained",
      6 * 3_600_000,
      expect.objectContaining({ apiKey: "secret-key" }),
    );
    expect(sdk.connect).not.toHaveBeenCalled();
  });
  it("observes a paused workspace without waking it or updating its timeout", async () => {
    sdk.getInfo.mockResolvedValue({
      sandboxId: "retained",
      state: "paused",
      metadata: { purpose: "t3-environment", account: "codex" },
    });
    expect(
      await createCloudDriver(config).renew({ sandboxId: "retained", providerInstanceId: "codex" }),
    ).toBe("paused");
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.setTimeout).not.toHaveBeenCalled();
  });
  it("distinguishes a pause racing renewal from a missing workspace", async () => {
    sdk.getInfo
      .mockResolvedValueOnce({
        sandboxId: "retained",
        state: "running",
        endAt: DateTime.toDateUtc(DateTime.makeUnsafe("2000-01-01T00:00:00Z")),
        metadata: { purpose: "t3-environment", account: "codex" },
      })
      .mockResolvedValueOnce({
        sandboxId: "retained",
        state: "paused",
        metadata: { purpose: "t3-environment", account: "codex" },
      });
    sdk.setTimeout.mockRejectedValueOnce(new SandboxNotFoundError("not running"));
    expect(
      await createCloudDriver(config).renew({ sandboxId: "retained", providerInstanceId: "codex" }),
    ).toBe("paused");
    expect(sdk.connect).not.toHaveBeenCalled();
  });
  it("distinguishes missing workspaces from provider availability failures", async () => {
    const driver = createCloudDriver(config);
    const input = { sandboxId: "retained", providerInstanceId: "codex" };
    sdk.getInfo.mockRejectedValue(new SandboxNotFoundError("not found"));
    expect(await driver.renew(input)).toBe("missing");
    await expect(driver.resume({ ...input, environmentId: "child" })).rejects.toBeInstanceOf(
      ProvisionedSandboxMissing,
    );
    sdk.getInfo.mockRejectedValue(new Error("temporary provider failure"));
    await expect(driver.renew(input)).rejects.toThrow("temporary provider failure");
    expect(sdk.connect).not.toHaveBeenCalled();
    expect(sdk.setTimeout).not.toHaveBeenCalled();
  });
  it("refuses to extend another account's workspace", async () => {
    sdk.getInfo.mockResolvedValue({
      sandboxId: "retained",
      state: "running",
      metadata: { purpose: "t3-environment", account: "other" },
    });
    await expect(
      createCloudDriver(config).renew({ sandboxId: "retained", providerInstanceId: "codex" }),
    ).rejects.toThrow("ownership");
    expect(sdk.setTimeout).not.toHaveBeenCalled();
  });
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
      expect.objectContaining({ timeoutMs: 6 * 3_600_000 }),
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
