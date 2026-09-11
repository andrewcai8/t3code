import { expect, it } from "vite-plus/test";

import { laneCapacity, rankLanes, windowGates, type Lane } from "./FleetCapacity.ts";

/**
 * Windows as the running fleet actually reported them, paired with whether a
 * real turn on that account succeeded. These are measurements, not invented
 * cases: every account below was sent the same prompt and its reply recorded.
 */
const observed = {
  codex_ac3: { windows: [{ id: "primary", usedPercent: 11 }], worked: true },
  codex_ac1: { windows: [{ id: "primary", usedPercent: 57 }], worked: true },
  codex_acai: { windows: [{ id: "primary", usedPercent: 78 }], worked: true },
  codex_uci: { windows: [{ id: "primary", usedPercent: 100 }], worked: false },
  cursor: {
    windows: [
      { id: "cursor_auto", usedPercent: 74.486 },
      { id: "cursor_api", usedPercent: 100 },
    ],
    worked: true,
  },
  cursor_work: {
    windows: [
      { id: "cursor_auto", usedPercent: 100 },
      { id: "cursor_api", usedPercent: 100 },
    ],
    worked: false,
  },
} as const;

const lane = (
  instanceId: string,
  windows: readonly { id: string; usedPercent: number }[],
): Lane => ({
  instanceId,
  driver: instanceId.split("_")[0] ?? instanceId,
  enabled: true,
  windows,
});

it("agrees with every account the fleet was actually measured on", () => {
  for (const [instanceId, { windows, worked }] of Object.entries(observed)) {
    const capacity = laneCapacity(lane(instanceId, windows), "composer-2.5");
    expect(
      capacity.kind === "available",
      `${instanceId} predicted ${capacity.kind}, but a real turn ${worked ? "succeeded" : "failed"}`,
    ).toBe(worked);
  }
});

// Claude reported five_hour at 10% and seven_day_fable at 100% on one account.
// A Fable turn was refused there and an Opus turn on the same account answered,
// so a family window must not park the whole account.
const claude = lane("claudeAgent", [
  { id: "five_hour", usedPercent: 10 },
  { id: "seven_day", usedPercent: 76 },
  { id: "seven_day_fable", usedPercent: 100 },
]);

it("parks only the model family whose window is spent", () => {
  expect(laneCapacity(claude, "claude-fable-5-1")).toEqual({
    kind: "exhausted",
    windowId: "seven_day_fable",
    resetsAt: undefined,
  });
  expect(laneCapacity(claude, "claude-opus-5")).toEqual({
    kind: "available",
    headroomPercent: 24,
    limitingWindow: "seven_day",
  });
});

it("ignores the pay-per-use channel subscription models never draw on", () => {
  expect(windowGates("cursor_api", "composer-2.5")).toBe(false);
  expect(windowGates("cursor_auto", "composer-2.5")).toBe(true);
});

it("measures headroom by the window that will stop the lane first", () => {
  const capacity = laneCapacity(
    lane("codex_x", [
      { id: "primary", usedPercent: 20 },
      { id: "secondary", usedPercent: 90 },
    ]),
    "gpt-5.6-luna",
  );
  expect(capacity).toEqual({ kind: "available", headroomPercent: 10, limitingWindow: "secondary" });
});

it("refuses to guess when a provider has not reported usage", () => {
  expect(laneCapacity({ ...lane("codex_new", []), windows: undefined }, "gpt-5.6-luna")).toEqual({
    kind: "unusable",
    reason: "capacity-unknown",
  });
  expect(laneCapacity(lane("codex_new", []), "gpt-5.6-luna")).toEqual({
    kind: "unusable",
    reason: "capacity-unknown",
  });
});

it("never routes to a disabled account", () => {
  expect(
    laneCapacity(
      { ...lane("codex_off", [{ id: "primary", usedPercent: 0 }]), enabled: false },
      "m",
    ),
  ).toEqual({
    kind: "unusable",
    reason: "disabled",
  });
});

it("sends work to the emptiest account first", () => {
  const ranked = rankLanes(
    [
      lane("codex_acai", [{ id: "primary", usedPercent: 78 }]),
      lane("codex_uci", [{ id: "primary", usedPercent: 100 }]),
      lane("codex_ac3", [{ id: "primary", usedPercent: 11 }]),
      lane("codex_ac1", [{ id: "primary", usedPercent: 57 }]),
    ],
    "gpt-5.6-luna",
  );
  expect(ranked.map((entry) => entry.instanceId)).toEqual(["codex_ac3", "codex_ac1", "codex_acai"]);
  expect(ranked[0]?.headroomPercent).toBe(89);
});
