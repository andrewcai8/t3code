import { describe, expect, it } from "vite-plus/test";

import {
  collectSettlementEnvironmentIds,
  environmentAllowsThreadSettlement,
} from "./threadSettled.ts";

describe("environmentAllowsThreadSettlement", () => {
  it("allows settle when the server advertised the command", () => {
    expect(environmentAllowsThreadSettlement({ threadSettlement: true })).toBe(true);
  });

  it("allows settle when no server config is loaded yet", () => {
    expect(environmentAllowsThreadSettlement(undefined)).toBe(true);
  });

  it("refuses settle on servers that predate the command", () => {
    expect(environmentAllowsThreadSettlement({})).toBe(false);
    expect(environmentAllowsThreadSettlement({ threadSettlement: false })).toBe(false);
  });

  it("includes disconnected environments that have no cached config", () => {
    const extra = "environment-disconnected";
    expect(
      collectSettlementEnvironmentIds(
        new Map([["environment-old", { environment: { capabilities: {} } }]]),
        [extra],
      ),
    ).toEqual(new Set([extra]));
  });
});
