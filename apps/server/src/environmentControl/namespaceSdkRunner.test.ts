import { describe, expect, it, vi } from "vite-plus/test";
import { namespaceT3Port } from "./namespaceProvisioner.ts";
import { createNamespaceSdkRunner, exposedOrigin } from "./namespaceSdkRunner.ts";

describe("Namespace runner boundary parsing", () => {
  it("parses the workspace URL returned by devbox url expose", () => {
    expect(exposedOrigin('{"urls":[{"url":"https://dbx.devbox.so/"}]}')).toBe(
      "https://dbx.devbox.so",
    );
  });
});

const api = vi.hoisted(() => ({ fetch: vi.fn(), activate: vi.fn() }));
vi.mock("@namespacelabs/sdk/api", () => ({
  createClient: () => api,
  createGlobalTransport: vi.fn(),
}));

const retainedResource = {
  provider: "namespace",
  devboxId: "dbx-retained",
  devboxName: "retained",
  instanceId: "old-instance",
  region: "iad",
  workspaceDir: "/Volumes/devbox/project",
  homeDir: "/Volumes/devbox/.t3-home",
} as const;

function resumeFixture(input: { running?: boolean; healthy?: boolean; identity?: string } = {}) {
  api.fetch.mockReset().mockResolvedValue({
    devbox: { id: retainedResource.devboxId, workspaceDir: "/Users/runner/workspaces" },
    instanceId: input.running ? "live-instance" : "",
  });
  api.activate.mockReset().mockResolvedValue({ instanceId: "new-instance" });
  let healthy = input.healthy ?? false;
  const execute = vi.fn(async (args: readonly string[]) => {
    if (args.some((arg) => arg.includes(" pair --ttl")))
      return { stdout: "Token: ABC123", stderr: "" };
    if (args.includes("cat")) return { stdout: input.identity ?? "env-retained\n", stderr: "" };
    if (args.includes("curl")) {
      if (!healthy) throw new Error("connection refused despite stale runtime file");
      return { stdout: '{"environmentId":"env-retained"}', stderr: "" };
    }
    if (args.includes("-d")) healthy = true;
    return { stdout: '{"urls":[{"url":"https://resumed.devbox.so/"}]}', stderr: "" };
  });
  return { runner: createNamespaceSdkRunner({ execute, token: "test" }), execute };
}

describe("Namespace retained resume", () => {
  it("activates the existing Devbox and restarts T3 after stale runtime files", async () => {
    const { runner, execute } = resumeFixture();
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).resolves.toEqual({
      resource: { ...retainedResource, instanceId: "new-instance" },
      upstreamOrigin: "https://resumed.devbox.so",
    });
    expect(api.activate).toHaveBeenCalledWith(
      { name: "retained", waitForReadiness: true, includeSshCredentials: false },
      { timeoutMs: 120_000 },
    );
    expect(execute.mock.calls.filter(([args]) => args.includes("-d"))).toHaveLength(1);
    expect(execute.mock.calls.flat(2).join(" ")).not.toMatch(/clone| pair |create|settings.json/);
  });

  it("keeps a healthy retained server running", async () => {
    const { runner, execute } = resumeFixture({ running: true, healthy: true });
    await runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" });
    expect(api.activate).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([args]) => args.includes("-d"))).toBe(false);
  });

  it("refuses missing or replaced Devboxes without creating anything", async () => {
    const { runner, execute } = resumeFixture();
    api.fetch.mockResolvedValue({ devbox: { id: "replacement" }, instanceId: "other" });
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).rejects.toThrow("identity");
    expect(execute).not.toHaveBeenCalled();
    api.fetch.mockRejectedValue(new Error("NotFound"));
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).rejects.toThrow("NotFound");
    expect(api.activate).not.toHaveBeenCalled();
  });

  it("refuses a missing retained environment before starting T3", async () => {
    const { runner, execute } = resumeFixture({ identity: "other-environment" });
    await expect(
      runner.resume({ resource: retainedResource, port: 3000, environmentId: "env-retained" }),
    ).rejects.toThrow("environment identity");
    expect(execute.mock.calls.some(([args]) => args.includes("-d"))).toBe(false);
  });
});

it("refuses legacy Namespace resources without a persistent home", async () => {
  const { runner, execute } = resumeFixture();
  const { homeDir: _homeDir, ...legacy } = retainedResource;
  await expect(
    runner.resume({ resource: legacy, port: 3000, environmentId: "env-retained" }),
  ).rejects.toThrow("retained home");
  expect(api.fetch).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { t3Port: undefined, expected: 3000 },
  { t3Port: 3001, expected: 3001 },
])("resumes the persisted service port $expected", async ({ t3Port, expected }) => {
  const { runner, execute } = resumeFixture();
  const resource = { ...retainedResource, t3Port };
  await runner.resume({ resource, port: namespaceT3Port(resource), environmentId: "env-retained" });
  const commands = execute.mock.calls.map(([args]) => args.join(" "));
  expect(
    commands.some((command) =>
      command.includes(`http://127.0.0.1:${expected}/.well-known/t3/environment`),
    ),
  ).toBe(true);
  expect(
    commands.some((command) =>
      command.includes(`serve --no-browser --host 0.0.0.0 --port ${expected}`),
    ),
  ).toBe(true);
  expect(commands).toContain(`url expose retained --port ${expected} --access workspace -o json`);
});

describe("Namespace pause after provider expiry", () => {
  it("reports missing only after the provider confirms the Devbox is gone", async () => {
    const { runner, execute } = resumeFixture();
    execute.mockRejectedValue(new Error("shutdown failed"));
    api.fetch.mockRejectedValue({ code: 5 });
    expect(await runner.destroyInstance(retainedResource)).toBe("missing");
    expect(api.fetch).toHaveBeenCalledWith(
      { id: retainedResource.devboxId },
      { timeoutMs: 30_000 },
    );
  });

  it("preserves shutdown failure for an existing Devbox", async () => {
    const { runner, execute } = resumeFixture();
    execute.mockRejectedValue(new Error("shutdown failed"));
    await expect(runner.destroyInstance(retainedResource)).rejects.toThrow("shutdown failed");
  });

  it("does not mistake failed provider lookup for absence", async () => {
    const { runner, execute } = resumeFixture();
    execute.mockRejectedValue(new Error("shutdown failed"));
    api.fetch.mockRejectedValue({ code: 7 });
    await expect(runner.destroyInstance(retainedResource)).rejects.toEqual({ code: 7 });
  });
});
