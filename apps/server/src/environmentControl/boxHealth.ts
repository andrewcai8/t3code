/**
 * Whether a cloud box is safe to pause. E2B captures a box's memory when it pauses, and a box
 * paused while pinned at full CPU with its envd agent not answering was captured frozen and could
 * not be resumed again. So a pause first reads the box: envd must answer a trivial command, and
 * the CPU must not be pinned.
 *
 * @module boxHealth
 */

export type BoxHealth =
  | { readonly kind: "healthy" }
  | { readonly kind: "pinned"; readonly cpuPercent: number }
  | { readonly kind: "unresponsive" };

/** A box whose CPU averaged this much over the last minute is pinned. */
const PINNED_CPU_PERCENT = 90;
/** A process below this share of a core is not what pins a box. */
const HEAVY_CPU_PERCENT = 25;
/** The most processes one relief stops. */
const MAX_STOPPED = 3;

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

/**
 * The heaviest processes the chat's agents left running, to stop when a box stays pinned: those
 * under the T3 server, which starts every agent and everything they run, using at least a
 * quarter of a core. Never the server itself. `ps` is `ps -eo pid=,ppid=,pcpu=,args=` output.
 */
export function heaviestAgentProcesses(
  ps: string,
  serverPid: number,
): ReadonlyArray<{ readonly pid: number; readonly cpuPercent: number; readonly command: string }> {
  const rows = ps
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null)
    .map(([, pid, ppid, cpu, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      cpuPercent: Number(cpu),
      command: (command ?? "").slice(0, 120),
    }));
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const underServer = (pid: number) => {
    for (let at = parents.get(pid), hops = 0; at !== undefined && hops < 64; hops += 1) {
      if (at === serverPid) return true;
      at = parents.get(at);
    }
    return false;
  };
  return rows
    .filter(
      (row) => row.pid !== serverPid && row.cpuPercent >= HEAVY_CPU_PERCENT && underServer(row.pid),
    )
    .toSorted((left, right) => right.cpuPercent - left.cpuPercent)
    .slice(0, MAX_STOPPED)
    .map(({ pid, cpuPercent, command }) => ({ pid, cpuPercent, command }));
}
