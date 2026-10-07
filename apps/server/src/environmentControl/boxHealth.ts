// @effect-diagnostics globalDate:off - a probe reads E2B's samples from a wall-clock window, Promise-side.
/**
 * Whether a cloud box may keep its memory when it pauses. E2B captures a box's memory when it
 * pauses, and boxes paused with their envd agent not answering were captured frozen and could not
 * be resumed again. So a pause first reads the box: envd must answer a trivial command, and the box
 * must not be pinned with its memory nearly full, the state that starves envd. A pinned CPU alone
 * is normal for a build or a test run, so it never costs a box its memory.
 *
 * @module boxHealth
 */

import { withinBudget } from "./boxBackup.ts";

export type BoxHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "pinned"; readonly cpuPercent: number; readonly memoryPercent: number }
  | { readonly kind: "unresponsive" };

/** One of E2B's metrics samples for a box. */
interface BoxSample {
  readonly timestamp: Date;
  readonly cpuUsedPct: number;
  readonly memUsed: number;
  readonly memTotal: number;
}

/** A box whose recent samples average this much CPU and this much memory in use is pinned. */
const PINNED_CPU_PERCENT = 90;
const PINNED_MEMORY_PERCENT = 90;
/**
 * How far back a probe reads E2B's samples. Short, so that load which ended before the probe has
 * mostly left them by the next one.
 */
const RECENT_SAMPLES_MS = 15_000;
/** How long envd has to answer a probe before its box is unresponsive. */
const ANSWER_MS = 5_000;

const average = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Probes a box once. `answered` is envd's reply to a trivial command, and only one that has not
 * come within ANSWER_MS makes the box unresponsive. Any other failure of it is thrown: an error
 * from E2B's API or proxy says nothing of the box. `samples` reads E2B's metrics since a time; a
 * box with no recent samples, or whose samples E2B fails to return, is not pinned.
 */
export async function readBoxHealth(input: {
  readonly answered: Promise<unknown>;
  readonly samples: (since: Date) => Promise<ReadonlyArray<BoxSample>>;
}): Promise<BoxHealth> {
  const since = new Date(Date.now() - RECENT_SAMPLES_MS);
  const [answer, samples] = await Promise.all([
    withinBudget(input.answered, ANSWER_MS),
    input.samples(since).catch(() => []),
  ]);
  if (answer === "timeout") return { kind: "unresponsive" };
  const recent = samples.filter((sample) => sample.timestamp >= since);
  if (recent.length === 0) return { kind: "healthy" };
  const cpuPercent = average(recent.map((sample) => sample.cpuUsedPct));
  const memoryPercent = average(recent.map((sample) => (sample.memUsed / sample.memTotal) * 100));
  return cpuPercent >= PINNED_CPU_PERCENT && memoryPercent >= PINNED_MEMORY_PERCENT
    ? {
        kind: "pinned",
        cpuPercent: Math.round(cpuPercent),
        memoryPercent: Math.round(memoryPercent),
      }
    : { kind: "healthy" };
}
