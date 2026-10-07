// @effect-diagnostics globalDate:off - samples are timestamped against the wall clock the probe reads.
import { describe, expect, it, vi } from "vite-plus/test";

import { readBoxHealth } from "./boxHealth.ts";

describe("readBoxHealth", () => {
  const answered = Promise.resolve();
  const GB = 1024 ** 3;
  /** A sample `seconds` old with this CPU and this share of an 8 GB box's memory in use. */
  const sample = (seconds: number, cpuUsedPct: number, memoryShare: number) => ({
    timestamp: new Date(Date.now() - seconds * 1_000),
    cpuUsedPct,
    memUsed: memoryShare * 8 * GB,
    memTotal: 8 * GB,
  });

  it("calls a box unresponsive only once envd has not answered for five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const health = readBoxHealth({
        answered: new Promise(() => {}),
        samples: async () => [sample(5, 10, 0.2)],
      });
      await vi.advanceTimersByTimeAsync(4_999);
      const early = await Promise.race([health, Promise.resolve("still waiting")]);
      expect(early).toBe("still waiting");
      await vi.advanceTimersByTimeAsync(1);
      expect(await health).toEqual({ kind: "unresponsive" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when E2B fails the command, since that says nothing of the box", async () => {
    await expect(
      readBoxHealth({
        answered: Promise.reject(new Error("502: sandbox proxy error")),
        samples: async () => [],
      }),
    ).rejects.toThrow("502: sandbox proxy error");
  });

  it("judges only recent samples, so load that ended before the probe does not pin the box", async () => {
    const earlier = [sample(40, 100, 0.95), sample(30, 100, 0.95)];
    expect(
      await readBoxHealth({
        answered,
        samples: async () => [...earlier, sample(10, 30, 0.5), sample(5, 20, 0.5)],
      }),
    ).toEqual({ kind: "healthy" });
    expect(
      await readBoxHealth({
        answered,
        samples: async () => [...earlier, sample(10, 96, 0.91), sample(5, 98, 0.91)],
      }),
    ).toEqual({ kind: "pinned", cpuPercent: 97, memoryPercent: 91 });
  });
});
