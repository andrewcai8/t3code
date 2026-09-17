import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isOffDeviceReachablePairingUrl,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });

  it("treats a sandbox-hosted pairing URL as reachable off this device", () => {
    expect(isOffDeviceReachablePairingUrl("https://3001-sandbox.e2b.app/pair#token=X")).toBe(true);
  });

  it("treats a loopback pairing URL as not reachable off this device", () => {
    expect(isOffDeviceReachablePairingUrl("http://127.0.0.1:50766/pair#token=X")).toBe(false);
  });
});
