import { expect, it } from "vite-plus/test";

import {
  MAX_REVIVAL_ATTEMPTS,
  decideRevival,
  revivalDelayMs,
  type RevivalInput,
} from "./AgentRevival.ts";

const died: RevivalInput = {
  status: "error",
  lastError: "ProviderAdapterSessionClosedError: codex adapter thread is closed",
  settled: false,
  stopRequested: false,
  attempts: 0,
};

it("revives a session that died with work still outstanding", () => {
  expect(decideRevival(died)).toEqual({ kind: "revive", attempt: 1, delayMs: 2_000 });
});

it("leaves a deliberate stop alone", () => {
  // The reactor records an intended stop as "stopped" and a death as "error".
  // Reviving the first would fight the person who asked for it.
  expect(decideRevival({ ...died, status: "stopped" })).toEqual({
    kind: "ignore",
    reason: "session-healthy",
  });
  expect(decideRevival({ ...died, stopRequested: true })).toEqual({
    kind: "ignore",
    reason: "stopped-deliberately",
  });
});

it("does not reopen a settled thread", () => {
  expect(decideRevival({ ...died, settled: true })).toEqual({
    kind: "ignore",
    reason: "thread-settled",
  });
});

it("treats a death with no recorded cause as an ordinary ending", () => {
  // Otherwise every thread that simply finished would be restarted.
  expect(decideRevival({ ...died, lastError: null })).toEqual({
    kind: "ignore",
    reason: "no-work-lost",
  });
});

it("gives up rather than burning quota on a thread that keeps dying", () => {
  expect(decideRevival({ ...died, attempts: MAX_REVIVAL_ATTEMPTS })).toEqual({
    kind: "exhausted",
    attempts: MAX_REVIVAL_ATTEMPTS,
  });
});

it("backs off between attempts and stops growing the gap", () => {
  expect([1, 2, 3, 4, 5].map(revivalDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
  // A session that dies on startup dies again immediately; a tight retry loop
  // turns one broken thread into an exhausted account.
  expect(revivalDelayMs(1)).toBeGreaterThan(0);
});

it("counts attempts so each retry waits longer than the last", () => {
  const first = decideRevival(died);
  const second = decideRevival({ ...died, attempts: 1 });
  expect(first.kind === "revive" && second.kind === "revive").toBe(true);
  if (first.kind === "revive" && second.kind === "revive")
    expect(second.delayMs).toBeGreaterThan(first.delayMs);
});
