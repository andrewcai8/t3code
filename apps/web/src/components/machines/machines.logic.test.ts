import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMachineRows,
  MACHINE_STALE_MS,
  meterPercent,
  meterTone,
  toMachineRow,
  type MachineSample,
} from "./machines.logic";

const GiB = 1024 ** 3;
const now = 1_000_000;
const id = (value: string) => value as EnvironmentId;

const resources = (overrides: Partial<HostResourcesSnapshot> = {}): HostResourcesSnapshot => ({
  sampledAt: now,
  cpuUtilization: 0.25,
  cpuCount: 8,
  availableMemoryBytes: 12 * GiB,
  totalMemoryBytes: 16 * GiB,
  diskTotalBytes: 500 * GiB,
  diskAvailableBytes: 125 * GiB,
  ...overrides,
});

const sample = (overrides: Partial<MachineSample> = {}): MachineSample => ({
  environmentId: id("env-a"),
  label: "Alpha",
  connected: true,
  resources: resources(),
  receivedAt: now - 1_000,
  pending: false,
  ...overrides,
});

describe("toMachineRow", () => {
  it("derives used and fractions from available bytes", () => {
    const row = toMachineRow(sample(), now);

    expect(row.status).toBe("live");
    expect(row.cpu).toEqual({ fraction: 0.25, cores: 8 });
    expect(row.memory).toEqual({ used: 4 * GiB, total: 16 * GiB, fraction: 0.25 });
    expect(row.disk).toEqual({ used: 375 * GiB, total: 500 * GiB, fraction: 0.75 });
    expect(row.staleSeconds).toBeNull();
  });

  it("hides disk when an older server does not report it", () => {
    const { diskTotalBytes: _total, diskAvailableBytes: _available, ...older } = resources();

    expect(toMachineRow(sample({ resources: older }), now).disk).toBeNull();
  });

  it("hides CPU until the host has a utilization sample", () => {
    const row = toMachineRow(sample({ resources: resources({ cpuUtilization: null }) }), now);

    expect(row.cpu).toBeNull();
    expect(row.memory).not.toBeNull();
  });

  it("clamps available bytes above the total", () => {
    const row = toMachineRow(
      sample({ resources: resources({ availableMemoryBytes: 32 * GiB }) }),
      now,
    );

    expect(row.memory).toEqual({ used: 0, total: 16 * GiB, fraction: 0 });
  });

  it("hides a meter whose total is zero", () => {
    const row = toMachineRow(
      sample({ resources: resources({ totalMemoryBytes: 0, availableMemoryBytes: 0 }) }),
      now,
    );

    expect(row.memory).toBeNull();
  });

  it("goes stale only after the freshness window, by the client's receive time", () => {
    expect(toMachineRow(sample({ receivedAt: now - MACHINE_STALE_MS }), now).status).toBe("live");

    const stale = toMachineRow(sample({ receivedAt: now - MACHINE_STALE_MS - 2_500 }), now);
    expect(stale.status).toBe("stale");
    expect(stale.staleSeconds).toBe(17);
    expect(stale.cpu).not.toBeNull();
  });

  it("does not mark a snapshot that arrived after the render clock as stale", () => {
    expect(toMachineRow(sample({ receivedAt: now + 500 }), now).status).toBe("live");
  });

  it("waits for a connected machine's first sample, and calls the rest offline", () => {
    expect(toMachineRow(sample({ resources: null, pending: true }), now).status).toBe("waiting");
    expect(toMachineRow(sample({ resources: null }), now).status).toBe("offline");
    expect(
      toMachineRow(sample({ resources: null, pending: true, connected: false }), now),
    ).toMatchObject({
      status: "offline",
    });
  });

  it("ignores old resources while the machine is disconnected", () => {
    const row = toMachineRow(sample({ connected: false }), now);

    expect(row.status).toBe("offline");
    expect(row.cpu).toBeNull();
    expect(row.memory).toBeNull();
    expect(row.disk).toBeNull();
  });
});

describe("buildMachineRows", () => {
  it("orders by name regardless of state", () => {
    const rows = buildMachineRows(
      [
        sample({ environmentId: id("3"), label: "pc-10", resources: null }),
        sample({ environmentId: id("1"), label: "Cloud" }),
        sample({ environmentId: id("2"), label: "pc-2", receivedAt: 0 }),
      ],
      now,
    );

    expect(rows.map((row) => row.label)).toEqual(["Cloud", "pc-2", "pc-10"]);
  });

  it("breaks name ties by environment id", () => {
    const rows = buildMachineRows(
      [
        sample({ environmentId: id("b"), label: "Box" }),
        sample({ environmentId: id("a"), label: "Box" }),
      ],
      now,
    );

    expect(rows.map((row) => row.environmentId)).toEqual(["a", "b"]);
  });
});

describe("meters", () => {
  it("picks a tone from how full the meter is", () => {
    expect(meterTone(0.74)).toBe("normal");
    expect(meterTone(0.75)).toBe("warning");
    expect(meterTone(0.9)).toBe("critical");
  });

  it("rounds and clamps percentages", () => {
    expect(meterPercent(0.256)).toBe(26);
    expect(meterPercent(1.2)).toBe(100);
    expect(meterPercent(-0.1)).toBe(0);
  });
});
