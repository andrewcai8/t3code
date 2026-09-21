import { describe, expect, it } from "vite-plus/test";
import { parsePairingUrlFields } from "./pairingFields";

describe("settings pairing fields", () => {
  it("keeps a manager gateway path when parsing a full pairing URL", () => {
    expect(
      parsePairingUrlFields(
        "https://manager.example/base/api/provisioned-environment/lease-1/pair#token=guest",
      ),
    ).toEqual({
      host: "https://manager.example/base/api/provisioned-environment/lease-1/",
      pairingCode: "guest",
    });
  });

  it("normalizes a direct root pairing URL", () => {
    expect(parsePairingUrlFields("https://remote.example/pair#token=guest")).toEqual({
      host: "https://remote.example/",
      pairingCode: "guest",
    });
  });
});
