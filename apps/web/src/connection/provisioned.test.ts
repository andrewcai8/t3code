import { describe, expect, it } from "vite-plus/test";
import { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { openProvisionedEnvironment } from "./provisioned";

const environment = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
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
      "wait:remote:existing-thread",
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
  it("keeps a missing existing thread explicit and supports an unclaimed environment", async () => {
    const ports = {
      isConnected: () => true,
      attach: async () => {
        throw new Error("unexpected attach");
      },
      pair: async () => {
        throw new Error("unexpected pair");
      },
      waitForThread: async () => false,
    };
    await expect(openProvisionedEnvironment(environment, ports)).rejects.toThrow("still loading");
    expect(await openProvisionedEnvironment({ ...environment, threadId: null }, ports)).toBeNull();
  });
});
