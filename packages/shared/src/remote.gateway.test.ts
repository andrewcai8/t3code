import { describe, expect, it } from "vite-plus/test";

import { resolveRemotePairingTarget } from "./remote.ts";

describe("remote through a provisioned environment gateway", () => {
  it("retains a manager gateway path while removing the pairing segment", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://manager.example/base/api/provisioned-environment/lease-1/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://manager.example/base/api/provisioned-environment/lease-1/",
      wsBaseUrl: "wss://manager.example/base/api/provisioned-environment/lease-1/",
    });
  });

  it("retains a manager gateway path when host and code are entered separately", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://manager.example/base/api/provisioned-environment/lease-1/",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://manager.example/base/api/provisioned-environment/lease-1/",
      wsBaseUrl: "wss://manager.example/base/api/provisioned-environment/lease-1/",
    });
  });
});
