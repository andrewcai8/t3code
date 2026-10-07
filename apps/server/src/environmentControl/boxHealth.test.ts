import { describe, expect, it } from "vite-plus/test";

import { heaviestAgentProcesses, judgeHealth } from "./boxHealth.ts";

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

describe("heaviestAgentProcesses", () => {
  const ps = [
    "    1     0  0.0 /sbin/init",
    "   50     1 30.0 /usr/bin/envd",
    "  100     1 40.0 node /home/user/.t3-provision/runtime/dist/bin.mjs start",
    "  200   100  0.5 claude --resume s-1",
    "  300   200 99.0 node vitest --watch",
    "  301   300 60.0 esbuild --service",
    "  400   200 10.0 rg needle",
    "  500   100 80.0 python3 train.py",
    "  600   100 45.0 cargo build",
  ].join("\n");

  it("picks the heaviest processes under the T3 server, never the server or the system", () => {
    expect(heaviestAgentProcesses(ps, 100)).toEqual([
      { pid: 300, cpuPercent: 99, command: "node vitest --watch" },
      { pid: 500, cpuPercent: 80, command: "python3 train.py" },
      { pid: 301, cpuPercent: 60, command: "esbuild --service" },
    ]);
  });

  it("finds nothing when the server is not in the table", () => {
    expect(heaviestAgentProcesses(ps, 9999)).toEqual([]);
  });
});
