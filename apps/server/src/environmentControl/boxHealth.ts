/**
 * Whether a cloud box may keep its memory when it pauses. E2B captures a box's memory when it
 * pauses, and a box paused while pinned at full CPU with its envd agent not answering was captured
 * frozen and could not be resumed again. So a pause first reads the box: envd must answer a
 * trivial command, and the CPU must not be pinned. A box that fails either is paused from its disk.
 *
 * @module boxHealth
 */

export type BoxHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "pinned"; readonly cpuPercent: number }
  | { readonly kind: "unresponsive" };

/** A box whose CPU averaged this much over the last minute is pinned. */
const PINNED_CPU_PERCENT = 90;

/**
 * Judges one probe: `answer` is what the box printed for `cat /proc/loadavg; nproc`, or null when
 * envd did not answer in time; `cpuSamples` are E2B's CPU percentages for the last minute. Without
 * samples, a one-minute load at or over the core count counts as pinned.
 */
export function judgeHealth(input: {
  readonly answer: string | null;
  readonly cpuSamples: ReadonlyArray<number>;
}): BoxHealth {
  if (input.answer === null) return { kind: "unresponsive" };
  const [loadLine = "", coresLine = ""] = input.answer.trim().split("\n");
  const load = Number(loadLine.split(/\s+/)[0]);
  const cores = Number(coresLine.trim());
  const cpuPercent =
    input.cpuSamples.length > 0
      ? input.cpuSamples.reduce((sum, sample) => sum + sample, 0) / input.cpuSamples.length
      : Number.isFinite(load) && cores > 0
        ? (load / cores) * 100
        : 0;
  return cpuPercent >= PINNED_CPU_PERCENT
    ? { kind: "pinned", cpuPercent: Math.round(cpuPercent) }
    : { kind: "healthy" };
}
