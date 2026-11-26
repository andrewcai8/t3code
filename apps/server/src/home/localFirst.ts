// @effect-diagnostics nodeBuiltinImport:off - pressure stall information is read from /proc.
/**
 * Local-first admission: whether a bun shim job runs on this host instead of in a copy. A job stays
 * local while the host's Linux pressure stall information (PSI) is under every ceiling and the
 * per-minute budget has room, and goes to a copy otherwise.
 *
 * @module localFirst
 */
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { LocalFirstSettings } from "./worktreeForksConfig.ts";

/** The `some avg10` share of the last ten seconds that tasks stalled on each resource, in percent. */
export interface Pressure {
  readonly cpu: number;
  readonly io: number;
  readonly memory: number;
}

/** Null when the host does not report pressure, which counts as busy. */
export type ReadPressure = Effect.Effect<Pressure | null>;

const BUDGET_WINDOW_MS = 60_000;

const avg10 = async (resource: keyof Pressure) => {
  const text = await NodeFSP.readFile(`/proc/pressure/${resource}`, "utf8");
  const value = /^some .*\bavg10=([\d.]+)/m.exec(text)?.[1];
  if (value === undefined) throw new Error(`No some avg10 in ${resource} pressure`);
  return Number(value);
};

export const readLinuxPressure: ReadPressure = Effect.promise(() =>
  Promise.all([avg10("cpu"), avg10("io"), avg10("memory")]).then(
    ([cpu, io, memory]): Pressure | null => ({ cpu, io, memory }),
    () => null,
  ),
);

export type Admission =
  | { readonly local: true; readonly pressure: Pressure }
  | { readonly local: false };

/** Decides each job in turn; the budget is the jobs it kept local within the last minute. */
export const makeLocalAdmission = (settings: LocalFirstSettings, read: ReadPressure) => {
  const kept: Array<number> = [];
  return Effect.gen(function* () {
    // Read first, so the budget is checked and spent with no wait between, and a burst of calls
    // cannot all pass it before PSI's ten-second average catches up.
    const pressure = yield* read;
    const now = yield* Clock.currentTimeMillis;
    while (kept.length > 0 && now - kept[0]! >= BUDGET_WINDOW_MS) kept.shift();
    if (
      pressure === null ||
      pressure.cpu >= settings.cpuBelow ||
      pressure.io >= settings.ioBelow ||
      pressure.memory >= settings.memoryBelow ||
      kept.length >= settings.maxPerMinute
    )
      return { local: false } satisfies Admission;
    kept.push(now);
    return { local: true, pressure } satisfies Admission;
  });
};
