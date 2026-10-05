// @effect-diagnostics globalDate:off - fixed timestamps exercise cleanup times.
import { describe, expect, it } from "vite-plus/test";

import { describeCloudCleanup, describeRestorable } from "./cloudCleanup.ts";

const now = Date.parse("2026-03-01T12:00:00.000Z");

describe("describeCloudCleanup", () => {
  it.each([
    {
      cleanup: { kind: "scheduled", at: "2026-03-07T12:00:00.000Z", reason: "idle" },
      shown: { text: "Removed in 6 days", action: "keep" },
    },
    {
      cleanup: { kind: "scheduled", at: "2026-03-02T12:00:00.000Z", reason: "idle" },
      shown: { text: "Removed in 1 day", action: "keep" },
    },
    {
      cleanup: { kind: "scheduled", at: "2026-03-01T17:00:00.000Z", reason: "idle" },
      shown: { text: "Removed in 5 hours", action: "keep" },
    },
    {
      cleanup: { kind: "scheduled", at: "2026-03-01T12:40:00.000Z", reason: "settled" },
      shown: { text: "Settled · Removed in 40 min", action: "keep" },
    },
    {
      cleanup: { kind: "scheduled", at: "2026-03-01T11:00:00.000Z", reason: "idle" },
      shown: { text: "Removed soon", action: "keep" },
    },
    {
      cleanup: { kind: "kept", reason: "user" },
      shown: { text: "Kept", action: "allow" },
    },
    {
      cleanup: { kind: "kept", reason: "unsaved-work" },
      shown: { text: "Kept · work could not be backed up", action: null },
    },
    { cleanup: undefined, shown: null },
  ] as const)("shows $shown.text", ({ cleanup, shown }) => {
    expect(describeCloudCleanup(cleanup, now)).toEqual(shown);
  });
});

describe("describeRestorable", () => {
  it("names the day a removed machine can be restored until, and nothing once it cannot", () => {
    expect(describeRestorable("2026-03-31T12:00:00.000Z", now)).toBe("Restorable until Mar 31");
    expect(describeRestorable("2026-03-01T11:00:00.000Z", now)).toBeNull();
    expect(describeRestorable(undefined, now)).toBeNull();
  });
});
