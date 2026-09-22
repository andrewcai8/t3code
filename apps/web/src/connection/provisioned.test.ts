import { describe, expect, it } from "vite-plus/test";
import { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { openProvisionedEnvironment } from "./provisioned";

const environment = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
  leaseId: "11111111-1111-4111-a111-111111111112",
  sandboxId: "sandbox-1",
  lifecycle: "active",
  environmentId: "remote",
  provider: "e2b",
  label: "proof/repo",
  repository: "proof/repo",
  projectDir: "/private/project",
  threadId: "existing-thread",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
});

describe("opening a discovered provisioned environment", () => {
  it("pairs once and returns the exact existing thread on subsequent opens", async () => {
    const calls: string[] = [];
    let connected = false;
    const ports = {
      isConnected: () => connected,
      attach: async () => {
        calls.push(`attach:${environment.requestId}`);
        return {
          kind: "attached" as const,
          environmentId: environment.environmentId,
          pairingUrl: "https://remote.invalid/pair#token=fresh",
        };
      },
      pair: async (url: string) => {
        calls.push(url);
        connected = true;
        return environment.environmentId;
      },
      waitForThread: async (ref: { environmentId: EnvironmentId; threadId: string }) => {
        calls.push(`wait:${ref.environmentId}:${ref.threadId}`);
        return true;
      },
      rememberLease: (ref: { environmentId: EnvironmentId; threadId: string } | null) => {
        calls.push(
          ref === null ? "remember:none" : `remember:${ref.environmentId}:${ref.threadId}`,
        );
      },
    };
    expect(await openProvisionedEnvironment(environment, ports)).toEqual({
      environmentId: "remote",
      threadId: "existing-thread",
    });
    expect(await openProvisionedEnvironment(environment, ports)).toEqual({
      environmentId: "remote",
      threadId: "existing-thread",
    });
    expect(calls).toEqual([
      `attach:${environment.requestId}`,
      "https://remote.invalid/pair#token=fresh",
      "remember:remote:existing-thread",
      "wait:remote:existing-thread",
      "remember:remote:existing-thread",
      "wait:remote:existing-thread",
    ]);
  });
  it("rejects attachment and pairing identity mismatches without opening a thread", async () => {
    let pairs = 0;
    let waits = 0;
    const ports = {
      isConnected: () => false,
      attach: async () => ({
        kind: "attached" as const,
        environmentId: EnvironmentId.make("other"),
        pairingUrl: "https://remote.invalid",
      }),
      pair: async () => {
        pairs++;
        return EnvironmentId.make("other");
      },
      rememberLease: () => {
        throw new Error("unexpected remember");
      },
      waitForThread: async () => {
        waits++;
        return true;
      },
    };
    await expect(openProvisionedEnvironment(environment, ports)).rejects.toThrow(
      "another environment",
    );
    expect(pairs).toBe(0);
    await expect(
      openProvisionedEnvironment(environment, {
        ...ports,
        attach: async () => ({
          kind: "attached",
          environmentId: environment.environmentId,
          pairingUrl: "https://remote.invalid",
        }),
      }),
    ).rejects.toThrow("does not match");
    expect(waits).toBe(0);
  });
  it("keeps a missing existing thread explicit", async () => {
    const ports = {
      isConnected: () => true,
      attach: async () => {
        throw new Error("unexpected attach");
      },
      pair: async () => {
        throw new Error("unexpected pair");
      },
      rememberLease: () => {},
      waitForThread: async () => false,
    };
    await expect(openProvisionedEnvironment(environment, ports)).rejects.toThrow("still loading");
  });
  it("records the lease against the environment when it has no thread yet", async () => {
    const calls: string[] = [];
    let connected = false;
    const ports = {
      isConnected: () => connected,
      attach: async () => ({
        kind: "attached" as const,
        environmentId: environment.environmentId,
        pairingUrl: "https://remote.invalid/pair#token=fresh",
      }),
      pair: async (url: string) => {
        calls.push(url);
        connected = true;
        return environment.environmentId;
      },
      waitForThread: async () => {
        throw new Error("unexpected wait");
      },
      rememberLease: (ref: { environmentId: EnvironmentId; threadId: string } | null) => {
        calls.push(
          ref === null ? "remember:none" : `remember:${ref.environmentId}:${ref.threadId}`,
        );
      },
    };
    expect(await openProvisionedEnvironment({ ...environment, threadId: null }, ports)).toBeNull();
    expect(calls).toEqual(["https://remote.invalid/pair#token=fresh", "remember:none"]);
  });
});
