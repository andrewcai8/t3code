/**
 * Whether a cloud box may keep its memory when it pauses. E2B captures a box's memory when it
 * pauses, and a box paused while pinned at full CPU with its envd agent not answering was captured
 * frozen and could not be resumed again. So a pause first reads the box: envd must answer a
 * trivial command, and the CPU must not be pinned. A box that fails either is paused from its disk.
 *
 * @module boxHealth
 */

import { withinBudget } from "./boxBackup.ts";

export type BoxHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "pinned"; readonly cpuPercent: number }
  | { readonly kind: "unresponsive" };

/** A box whose recent CPU samples average this much is pinned. */
const PINNED_CPU_PERCENT = 90;
/**
 * How far back a probe reads E2B's CPU samples. Short, so that load which ended before the probe,
 * such as a save, has mostly left them by the next one.
 */
const RECENT_CPU_MS = 15_000;
/** How long envd has to answer a probe before its box is unresponsive. */
const ANSWER_MS = 5_000;

/**
 * Judges one probe: `answer` is what the box printed for `cat /proc/loadavg; nproc`, or null when
 * envd did not answer in time; `cpuSamples` are E2B's recent CPU percentages. Without samples, a
 * one-minute load at or over the core count counts as pinned.
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

/**
 * Probes a box once. `answer` is envd's reply to `cat /proc/loadavg; nproc`, and only one that has
 * not come within ANSWER_MS makes the box unresponsive. Any other failure is thrown: an error from
 * E2B's API or proxy says nothing of the box. `cpuSamples` reads E2B's samples since a time.
 */
export async function readBoxHealth(input: {
  readonly answer: Promise<string>;
  readonly cpuSamples: (
    since: Date,
  ) => Promise<ReadonlyArray<{ readonly timestamp: Date; readonly cpuUsedPct: number }>>;
}): Promise<BoxHealth> {
  const since = new Date(Date.now() - RECENT_CPU_MS);
  const [answer, samples] = await Promise.all([
    withinBudget(input.answer, ANSWER_MS),
    input.cpuSamples(since).catch(() => []),
  ]);
  return judgeHealth({
    answer: answer === "timeout" ? null : answer,
    cpuSamples: samples
      .filter((sample) => sample.timestamp >= since)
      .map((sample) => sample.cpuUsedPct),
  });
}
