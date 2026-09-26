import { describe, expect, it } from "vite-plus/test";

import { makeCursorAccountHistory } from "./cursorAccountHistory.ts";
import type { CursorAccountUsageReadResult } from "./cursorUsageReader.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-20T12:00:00Z");

const record = (timestampMs: number): UsageRecord => ({
  provider: "cursor",
  timestampMs,
  model: "auto",
  sessionId: "",
  totals: {
    uncachedInputTokens: 1,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
  },
  reportedCostUsd: 0.01,
  fast: false,
  dedupeKey: `cursor-account:a:${timestampMs}`,
});

function fakeAccount(timestamps: readonly number[]) {
  const reads: Array<readonly [number, number]> = [];
  let accountKey = "account-a";
  const read = async (
    _source: unknown,
    sinceMs: number,
    untilMs: number,
  ): Promise<CursorAccountUsageReadResult> => {
    reads.push([sinceMs, untilMs]);
    return {
      accountKey,
      records: timestamps.filter((t) => t >= sinceMs && t <= untilMs).map(record),
      missing: false,
      error: null,
    };
  };
  return {
    read,
    reads,
    switchAccount: (key: string) => {
      accountKey = key;
    },
  };
}

describe("makeCursorAccountHistory", () => {
  const since = NOW - 48 * HOUR_MS;
  const rows = [NOW - 30 * HOUR_MS, NOW - 2 * HOUR_MS, NOW - 10 * 60 * 1000];

  it("reads settled history once and only the unsettled tail after the TTL", async () => {
    const account = fakeAccount(rows);
    let now = NOW;
    const history = makeCursorAccountHistory(account.read, () => now);

    const first = await history("/home/a/auth.json", since, NOW);
    now += 30_000;
    await history("/home/a/auth.json", since, now);
    now += 60_000;
    const third = await history("/home/a/auth.json", since, now);

    expect(first.records.map((r) => r.timestampMs)).toEqual(rows);
    expect(third.records.map((r) => r.timestampMs)).toEqual(rows);
    expect(account.reads).toEqual([
      [since, NOW - HOUR_MS],
      [NOW - HOUR_MS + 1, NOW],
      // The tail read settles the rows that aged past an hour since the first read.
      [NOW - HOUR_MS + 1, now - HOUR_MS],
      [now - HOUR_MS + 1, now],
    ]);
  });

  it("drops kept history when the login now names another account", async () => {
    const account = fakeAccount(rows);
    let now = NOW;
    const history = makeCursorAccountHistory(account.read, () => now);

    await history("/home/a/auth.json", since, NOW);
    account.switchAccount("account-b");
    now += 2 * 60_000;
    const after = await history("/home/a/auth.json", since, now);

    expect(after.accountKey).toBe("account-b");
    expect(account.reads.slice(-2)).toEqual([
      [since, now - HOUR_MS],
      [now - HOUR_MS + 1, now],
    ]);
  });

  it("returns a failed read without caching it", async () => {
    const reads: number[] = [];
    const history = makeCursorAccountHistory(
      async () => {
        reads.push(1);
        return {
          accountKey: "account-a",
          records: [],
          missing: false,
          error: "Cursor account usage could not be read.",
        };
      },
      () => NOW,
    );
    const first = await history({ kind: "keychain" }, since, NOW);
    await history({ kind: "keychain" }, since, NOW);
    expect(first.error).toBe("Cursor account usage could not be read.");
    expect(reads.length).toBe(4);
  });
});
