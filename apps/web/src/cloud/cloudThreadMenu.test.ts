import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../components/threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("a thread with a cloud machine", () => {
  it("places cloud machine teardown after lifecycle actions and before rename", () => {
    const items = buildThreadActionMenuItems({ ...baseState, hasProvisionedCloudMachine: true });
    const stopIndex = items.findIndex((item) => item.id === "stop-cloud-machine");
    const renameIndex = items.findIndex((item) => item.id === "rename");
    expect(stopIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(renameIndex);
    expect(items[stopIndex]).toMatchObject({
      label: "Stop cloud machine",
      icon: "cloud",
      destructive: true,
      separatorBefore: true,
    });
    expect(
      buildThreadActionMenuItems(baseState).find((item) => item.id === "stop-cloud-machine"),
    ).toBeUndefined();
  });
});
