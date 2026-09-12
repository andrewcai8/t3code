import { describe, expect, it } from "vite-plus/test";
import {
  disposeNamespaceTransport,
  provisionNamespaceTransport,
  type NamespaceMac,
} from "./namespaceTransport.ts";
import type { NamespaceResource } from "./namespaceProvisioner.ts";

const resource: NamespaceResource = {
  provider: "namespace",
  devboxId: "dbx",
  instanceId: "inst",
  region: "us",
  workspaceDir: "/Users/runner/work",
};
const endpoint = {
  httpBaseUrl: "https://relay.test",
  wsBaseUrl: "wss://relay.test",
  providerKind: "t3_relay" as const,
};

function macWith(events: string[]): NamespaceMac {
  return {
    create: async () => {
      events.push("create");
      return resource;
    },
    bootstrap: async ({ connectorToken }) => {
      events.push(`bootstrap:${connectorToken}`);
      return { pairingToken: "pairing-token" };
    },
    destroyInstance: async () => {
      events.push("destroy");
    },
    expireDevbox: async () => {
      events.push("expire");
    },
  };
}

describe("Namespace relay transport", () => {
  it("provisions in order and returns a credential-free lease", async () => {
    const events: string[] = [];
    const lease = await provisionNamespaceTransport(
      macWith(events),
      {
        provision: async () => {
          events.push("relay-provision");
          return { endpoint, connectorToken: "secret" };
        },
        release: async () => {
          events.push("relay-release");
        },
      },
      {
        put: async (token) => {
          events.push(`put:${token}`);
          return "token-1";
        },
        delete: async (id) => {
          events.push(`delete:${id}`);
        },
      },
      {
        environmentId: "env-1",
        label: "chat",
        origin: "desktop",
        size: "m",
        providerInstanceId: "p",
      },
    );
    expect(events).toEqual(["create", "relay-provision", "put:secret", "bootstrap:secret"]);
    expect(lease).toMatchObject({
      pairingUrl: "https://relay.test/pair#token=pairing-token",
      environmentId: "env-1",
      connectorTokenId: "token-1",
      resource,
    });
    expect(lease).not.toHaveProperty("connectorToken");
  });

  it("compensates in reverse order when bootstrap fails", async () => {
    const events: string[] = [];
    const mac: NamespaceMac = {
      ...macWith(events),
      bootstrap: async () => {
        events.push("bootstrap");
        throw new Error("boom");
      },
    };
    await expect(
      provisionNamespaceTransport(
        mac,
        {
          provision: async () => {
            events.push("relay-provision");
            return { endpoint, connectorToken: "secret" };
          },
          release: async () => {
            events.push("relay-release");
          },
        },
        {
          put: async () => "token-1",
          delete: async () => {
            events.push("delete");
          },
        },
        {
          environmentId: "env-1",
          label: "chat",
          origin: "desktop",
          size: "m",
          providerInstanceId: "p",
        },
      ),
    ).rejects.toThrow("boom");
    expect(events).toEqual([
      "create",
      "relay-provision",
      "bootstrap",
      "delete",
      "relay-release",
      "destroy",
      "expire",
    ]);
  });

  it("attempts every cleanup step so retries are safe", async () => {
    const events: string[] = [];
    const lease = { resource, environmentId: "env-1", connectorTokenId: "token-1" };
    const deps = {
      release: async () => {
        events.push("release");
      },
      put: async () => "x",
      delete: async () => {
        events.push("delete");
      },
    };
    const mac = macWith(events);
    await disposeNamespaceTransport(mac, deps, deps, lease);
    await disposeNamespaceTransport(mac, deps, deps, lease);
    expect(events).toEqual([
      "delete",
      "release",
      "destroy",
      "expire",
      "delete",
      "release",
      "destroy",
      "expire",
    ]);
  });
});
