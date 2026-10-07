import { describe, expect, it } from "vite-plus/test";

import { judgeHealth } from "./boxHealth.ts";

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
