import { describe, expect, it, vi } from "vite-plus/test";

import { judgeHealth, readBoxHealth } from "./boxHealth.ts";

describe("judgeHealth", () => {
  it("calls a box whose envd did not answer unresponsive", () => {
    expect(judgeHealth({ answer: null, cpuSamples: [5] })).toEqual({ kind: "unresponsive" });
  });

  it("reads E2B's CPU samples over the load average", () => {
    expect(
      judgeHealth({ answer: "0.10 0.20 0.30 1/200 999\n2\n", cpuSamples: [99, 97, 98] }),
    ).toEqual({
      kind: "pinned",
      cpuPercent: 98,
    });
    expect(judgeHealth({ answer: "7.90 7.80 7.50 9/200 999\n2\n", cpuSamples: [12, 20] })).toEqual({
      kind: "healthy",
    });
  });

  it("falls back to the load per core without samples", () => {
    expect(judgeHealth({ answer: "2.10 1.90 1.50 3/180 4242\n2\n", cpuSamples: [] })).toEqual({
      kind: "pinned",
      cpuPercent: 105,
    });
    expect(judgeHealth({ answer: "0.40 0.30 0.20 1/180 4242\n2\n", cpuSamples: [] })).toEqual({
      kind: "healthy",
    });
  });
});

describe("readBoxHealth", () => {
  const quiet = Promise.resolve("0.10 0.20 0.30 1/200 999\n2\n");
  const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1_000);

  it("calls a box unresponsive only once envd has not answered for five seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const health = readBoxHealth({
        answer: new Promise<string>(() => {}),
        cpuSamples: async () => [],
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await health).toEqual({ kind: "unresponsive" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when E2B fails the command, since that says nothing of the box", async () => {
    await expect(
      readBoxHealth({
        answer: Promise.reject(new Error("502: sandbox proxy error")),
        cpuSamples: async () => [],
      }),
    ).rejects.toThrow("502: sandbox proxy error");
  });

  it("judges only recent samples, so load that ended before the probe does not pin the box", async () => {
    const earlier = [
      { timestamp: secondsAgo(40), cpuUsedPct: 100 },
      { timestamp: secondsAgo(30), cpuUsedPct: 100 },
    ];
    expect(
      await readBoxHealth({
        answer: quiet,
        cpuSamples: async () => [
          ...earlier,
          { timestamp: secondsAgo(10), cpuUsedPct: 30 },
          { timestamp: secondsAgo(5), cpuUsedPct: 20 },
        ],
      }),
    ).toEqual({ kind: "healthy" });
    expect(
      await readBoxHealth({
        answer: quiet,
        cpuSamples: async () => [
          ...earlier,
          { timestamp: secondsAgo(10), cpuUsedPct: 96 },
          { timestamp: secondsAgo(5), cpuUsedPct: 98 },
        ],
      }),
    ).toEqual({ kind: "pinned", cpuPercent: 97 });
  });
});
