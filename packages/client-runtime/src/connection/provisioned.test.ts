import { DiscoveredProvisionedEnvironment, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { isOffDeviceReachablePairingUrl, joinProvisionedEnvironment } from "./provisioned.ts";

const environment = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
  environmentId: "remote",
  provider: "namespace",
  label: "proof/repo",
  repository: "proof/repo",
  projectDir: "/private/project",
  threadId: "existing-thread",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
});

function ports(options: {
  readonly pairingUrl: (mint: number) => string;
  readonly canReach: (pairingUrl: string) => boolean;
}) {
  const calls: Array<string> = [];
  let mints = 0;
  return {
    calls,
    ports: {
      isConnected: () => false,
      attach: async () => {
        mints += 1;
        calls.push(`attach:${mints}`);
        return {
          kind: "attached" as const,
          environmentId: environment.environmentId,
          pairingUrl: options.pairingUrl(mints),
        };
      },
      pair: async (pairingUrl: string) => {
        calls.push(`pair:${pairingUrl}`);
        return environment.environmentId;
      },
      canReach: options.canReach,
    },
  };
}

describe("isOffDeviceReachablePairingUrl", () => {
  it("treats a sandbox-hosted pairing URL as reachable off this device", () => {
    expect(isOffDeviceReachablePairingUrl("https://3001-sandbox.e2b.app/pair#token=X")).toBe(true);
  });

  it("treats a loopback pairing URL as not reachable off this device", () => {
    expect(isOffDeviceReachablePairingUrl("http://127.0.0.1:50766/pair#token=X")).toBe(false);
    expect(isOffDeviceReachablePairingUrl("http://localhost:50766/pair#token=X")).toBe(false);
    expect(isOffDeviceReachablePairingUrl("http://[::1]:50766/pair#token=X")).toBe(false);
  });

  it("treats something that is not a URL as not reachable", () => {
    expect(isOffDeviceReachablePairingUrl("not a pairing url")).toBe(false);
  });
});

describe("joinProvisionedEnvironment", () => {
  it("pairs with the URL attach just minted when this client can reach it", async () => {
    const { calls, ports: joinPorts } = ports({
      pairingUrl: () => "https://3001-sandbox.e2b.app/pair#token=fresh",
      canReach: isOffDeviceReachablePairingUrl,
    });

    expect(await joinProvisionedEnvironment(environment, joinPorts)).toEqual({ kind: "joined" });
    expect(calls).toEqual(["attach:1", "pair:https://3001-sandbox.e2b.app/pair#token=fresh"]);
  });

  it("reports a loopback pairing URL as unreachable instead of pairing with it", async () => {
    const { calls, ports: joinPorts } = ports({
      pairingUrl: () => "http://127.0.0.1:50766/pair#token=fresh",
      canReach: isOffDeviceReachablePairingUrl,
    });

    expect(await joinProvisionedEnvironment(environment, joinPorts)).toEqual({
      kind: "unreachable",
    });
    expect(calls).toEqual(["attach:1"]);
  });

  it("mints a fresh pairing URL on every join rather than reusing the last one", async () => {
    const { calls, ports: joinPorts } = ports({
      pairingUrl: (mint) => `https://3001-sandbox.e2b.app/pair#token=${mint}`,
      canReach: () => true,
    });

    await joinProvisionedEnvironment(environment, joinPorts);
    await joinProvisionedEnvironment(environment, joinPorts);

    expect(calls).toEqual([
      "attach:1",
      "pair:https://3001-sandbox.e2b.app/pair#token=1",
      "attach:2",
      "pair:https://3001-sandbox.e2b.app/pair#token=2",
    ]);
  });

  it("does not mint anything for an environment this client is already connected to", async () => {
    const { calls, ports: joinPorts } = ports({
      pairingUrl: () => "https://3001-sandbox.e2b.app/pair#token=fresh",
      canReach: () => true,
    });

    expect(
      await joinProvisionedEnvironment(environment, { ...joinPorts, isConnected: () => true }),
    ).toEqual({ kind: "joined" });
    expect(calls).toEqual([]);
  });

  it("passes a refusal from the manager through with its message", async () => {
    const { calls, ports: joinPorts } = ports({
      pairingUrl: () => "https://3001-sandbox.e2b.app/pair#token=fresh",
      canReach: () => true,
    });

    expect(
      await joinProvisionedEnvironment(environment, {
        ...joinPorts,
        attach: async () => ({ kind: "refused", message: "The lease has expired." }),
      }),
    ).toEqual({ kind: "refused", message: "The lease has expired." });
    expect(calls).toEqual([]);
  });

  it("refuses identity mismatches before and after pairing", async () => {
    const { calls, ports: joinPorts } = ports({
      pairingUrl: () => "https://3001-sandbox.e2b.app/pair#token=fresh",
      canReach: () => true,
    });

    expect(
      await joinProvisionedEnvironment(environment, {
        ...joinPorts,
        attach: async () => ({
          kind: "attached",
          environmentId: EnvironmentId.make("other"),
          pairingUrl: "https://3001-sandbox.e2b.app/pair#token=fresh",
        }),
      }),
    ).toEqual({ kind: "refused", message: "The connection belongs to another environment." });
    expect(calls).toEqual([]);

    expect(
      await joinProvisionedEnvironment(environment, {
        ...joinPorts,
        pair: async () => EnvironmentId.make("other"),
      }),
    ).toEqual({ kind: "refused", message: "The paired server does not match this environment." });
    expect(calls).toEqual(["attach:1"]);
  });
});
