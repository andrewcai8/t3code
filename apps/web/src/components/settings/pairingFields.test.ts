import { describe, expect, it } from "vite-plus/test";

import { pairingUrlHost } from "./pairingFields";

describe("settings pairing fields", () => {
  it("keeps a manager gateway path when parsing a full pairing URL", () => {
    expect(
      pairingUrlHost(
        new URL(
          "https://manager.example/base/api/provisioned-environment/lease-1/pair#token=guest",
        ),
      ),
    ).toBe("https://manager.example/base/api/provisioned-environment/lease-1/");
  });

  it("normalizes a direct root pairing URL", () => {
    expect(pairingUrlHost(new URL("https://remote.example/pair#token=guest"))).toBe(
      "https://remote.example/",
    );
  });
});
