import type { EnvironmentId, HostResourcesSnapshot } from "@t3tools/contracts";

/** Same freshness window `chooseLoadBalancedEnvironment` uses for a host's resources. */
export const MACHINE_STALE_MS = 15_000;

export interface MachineSample {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** The last snapshot received, even when a later read failed. */
  readonly resources: HostResourcesSnapshot | null;
  /** When the client received `resources`; the server's clock is not trusted. */
  readonly receivedAt: number;
  /** A first read is still in flight. */
  readonly pending: boolean;
}

export interface MachineMeter {
  readonly used: number;
  readonly total: number;
  readonly fraction: number;
}

export type MachineStatus = "live" | "stale" | "waiting" | "offline";

export interface MachineRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: MachineStatus;
  /** Whole seconds since the snapshot arrived; set only for a stale row. */
  readonly staleSeconds: number | null;
  readonly cpu: { readonly fraction: number; readonly cores: number } | null;
  readonly memory: MachineMeter | null;
  readonly disk: MachineMeter | null;
}

function meter(total: number, available: number): MachineMeter | null {
  if (!(total > 0)) return null;
  const used = Math.min(total, Math.max(0, total - available));
  return { used, total, fraction: used / total };
}

export function toMachineRow(sample: MachineSample, now: number): MachineRow {
  const { resources } = sample;
  const base = { environmentId: sample.environmentId, label: sample.label };
  if (!sample.connected || resources === null) {
    return {
      ...base,
      status: sample.connected && sample.pending ? "waiting" : "offline",
      staleSeconds: null,
      cpu: null,
      memory: null,
      disk: null,
    };
  }
  const ageMs = Math.max(0, now - sample.receivedAt);
  const stale = ageMs > MACHINE_STALE_MS;
  return {
    ...base,
    status: stale ? "stale" : "live",
    staleSeconds: stale ? Math.floor(ageMs / 1000) : null,
    cpu:
      resources.cpuUtilization === null
        ? null
        : { fraction: resources.cpuUtilization, cores: resources.cpuCount },
    memory: meter(resources.totalMemoryBytes, resources.availableMemoryBytes),
    disk:
      resources.diskTotalBytes === undefined || resources.diskAvailableBytes === undefined
        ? null
        : meter(resources.diskTotalBytes, resources.diskAvailableBytes),
  };
}

/** By name, never by state, so rows do not jump as machines come and go. */
export function buildMachineRows(
  samples: ReadonlyArray<MachineSample>,
  now: number,
): ReadonlyArray<MachineRow> {
  return samples
    .map((sample) => toMachineRow(sample, now))
    .toSorted(
      (a, b) =>
        a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }) ||
        a.environmentId.localeCompare(b.environmentId),
    );
}

export type MeterTone = "normal" | "warning" | "critical";

export function meterTone(fraction: number): MeterTone {
  if (fraction >= 0.9) return "critical";
  if (fraction >= 0.75) return "warning";
  return "normal";
}

export function meterPercent(fraction: number): number {
  return Math.min(100, Math.max(0, Math.round(fraction * 100)));
}
