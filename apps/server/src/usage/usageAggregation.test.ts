import { describe, expect, it } from "@effect/vitest";

import * as Schema from "effect/Schema";

import { addTranscript, type AggregateOptions, UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(
  records: readonly UsageRecord[],
  timeZone = "UTC",
  resolution: "day" | "hour" = "day",
) {
  const hourlyBounds =
    resolution === "hour"
      ? {
          sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
          untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
        }
      : {};
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    resolution,
    ...hourlyBounds,
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("requires exact bounds for hourly aggregation", () => {
    expect(
      () =>
        new UsageAggregator({
          timeZone: "UTC",
          sinceDay: "2026-08-01",
          untilDay: "2026-08-31",
          resolution: "hour",
          rates,
        }),
    ).toThrow("requires exact time bounds");
  });

  it("keeps only the first record for a repeated dedupe key", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
    ]);

    expect(result.duplicatesDropped).toBe(2);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.records).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("still sums records that carry no dedupe key", () => {
    const result = aggregate([record(), record()]);

    expect(result.duplicatesDropped).toBe(0);
    expect(result.buckets[0]?.totals.outputTokens).toBe(100);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("splits an hourly request into fixed buckets anchored to its exact start", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-07T02:40:13.944Z") }),
        record({ timestampMs: Date.parse("2026-08-07T03:40:13.944Z") }),
      ],
      "America/Los_Angeles",
      "hour",
    );

    expect(result.buckets.map((bucket) => [bucket.day, bucket.hourStart])).toEqual([
      ["2026-08-06", "2026-08-07T02:37:00.000Z"],
      ["2026-08-06", "2026-08-07T03:37:00.000Z"],
    ]);
  });

  it("uses an inclusive start and exclusive end for rolling windows", () => {
    const result = aggregate(
      [
        record({ timestampMs: Date.parse("2026-08-06T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-06T04:37:00.000Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:36:59.999Z") }),
        record({ timestampMs: Date.parse("2026-08-07T04:37:00.000Z") }),
      ],
      "UTC",
      "hour",
    );

    expect(result.outOfWindow).toBe(2);
    expect(result.buckets.map((bucket) => bucket.hourStart)).toEqual([
      "2026-08-06T04:37:00.000Z",
      "2026-08-07T03:37:00.000Z",
    ]);
  });

  it("keeps daily payloads collapsed when hourly resolution is not requested", () => {
    const result = aggregate([
      record({ timestampMs: Date.parse("2026-08-07T04:05:13.944Z") }),
      record({ timestampMs: Date.parse("2026-08-07T05:05:13.944Z") }),
    ]);

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.hourStart).toBeUndefined();
    expect(result.buckets[0]?.records).toBe(2);
  });

  it("prices against the rate table", () => {
    const result = aggregate([record()]);

    // 100*1e-5 + 1000*1e-6 + 10*1.25e-5 + 50*5e-5
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.004625, 9);
    expect(result.buckets[0]?.costSource).toBe("modelPriced");
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("drops records outside the window", () => {
    const result = aggregate([record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") })]);

    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("reports whether a record contributed", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(false);
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }))).toBe(false);
  });

  it("separates providers and models into their own buckets", () => {
    const result = aggregate([
      record(),
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-opus-5" }),
    ]);

    expect(result.buckets).toHaveLength(3);
  });
});

describe("addTranscript", () => {
  const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
  const inWindow = Date.parse("2026-08-06T20:00:00Z");
  const lateEvening = Date.parse("2026-08-07T06:30:00Z");
  const earlyMorning = Date.parse("2026-08-06T02:00:00Z");
  const longAgo = Date.parse("2026-07-20T12:00:00Z");

  const codex = (timestampMs: number, outputTokens: number) =>
    record({
      provider: "codex",
      model: "gpt-5.6-sol",
      sessionId: "rollout-1",
      timestampMs,
      totals: { ...record().totals, outputTokens },
    });
  const claude = (timestampMs: number, outputTokens: number, dedupeKey: string | null = null) =>
    record({
      sessionId: "session-b",
      timestampMs,
      dedupeKey,
      totals: { ...record().totals, outputTokens },
    });
  const rollout = () => [
    codex(inWindow, 11),
    codex(inWindow, 12),
    codex(inWindow, 11),
    codex(longAgo, 1000),
    codex(lateEvening, 13),
  ];
  const files: readonly (readonly UsageRecord[])[] = [
    rollout(),
    // A moved copy of the same rollout contributes nothing.
    rollout(),
    [claude(longAgo, 2000, "msg_1:"), claude(earlyMorning, 17), claude(inWindow, 19)],
    // The first copy of a key wins even when it fell outside the window.
    [claude(inWindow, 3000, "msg_1:")],
  ];

  /** The scan loop as it ran before out-of-window records were skipped. */
  function referenceFold(aggregator: UsageAggregator) {
    const sessionIds = new Set<string>();
    for (const records of files) {
      const occurrences = new Map<string, number>();
      for (const item of records) {
        let usageRecord = item;
        if (item.provider === "codex" && item.sessionId.length > 0) {
          const key = encodeKey([
            item.provider,
            item.sessionId,
            item.timestampMs,
            item.model,
            item.totals,
          ]);
          const occurrence = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occurrence);
          usageRecord = { ...item, dedupeKey: key + ":" + occurrence };
        }
        if (aggregator.add(usageRecord) && item.sessionId.length > 0) {
          sessionIds.add(item.sessionId);
        }
      }
    }
    return { buckets: aggregator.finish().buckets, sessionIds: [...sessionIds].toSorted() };
  }

  function fold(aggregator: UsageAggregator) {
    const sessionIds = new Set<string>();
    for (const records of files) addTranscript(aggregator, records, sessionIds);
    return { buckets: aggregator.finish().buckets, sessionIds: [...sessionIds].toSorted() };
  }

  const windows: readonly AggregateOptions[] = [
    {
      timeZone: "America/Los_Angeles",
      sinceDay: "2026-08-06",
      untilDay: "2026-08-07",
      resolution: "hour",
      sinceTimeMs: Date.parse("2026-08-06T04:37:00.000Z"),
      untilTimeMs: Date.parse("2026-08-07T04:37:00.000Z"),
      rates,
    },
    { timeZone: "America/Los_Angeles", sinceDay: "2026-08-06", untilDay: "2026-08-06", rates },
    { timeZone: "Pacific/Kiritimati", sinceDay: "2026-08-07", untilDay: "2026-08-07", rates },
    { timeZone: "Pacific/Pago_Pago", sinceDay: "2026-08-06", untilDay: "2026-08-06", rates },
    { timeZone: "UTC", sinceDay: "2026-07-01", untilDay: "2026-08-31", rates },
  ];

  it("matches the unfiltered scan loop in every window", () => {
    for (const options of windows) {
      expect(fold(new UsageAggregator(options))).toEqual(
        referenceFold(new UsageAggregator(options)),
      );
    }
  });

  it("keeps repeated Codex events and drops keys first seen out of window", () => {
    const outputTokens = (options: AggregateOptions) =>
      fold(new UsageAggregator(options)).buckets.map((bucket) => [
        bucket.provider,
        bucket.totals.outputTokens,
      ]);

    expect(outputTokens(windows[0]!)).toEqual([
      ["claude", 19],
      ["codex", 34],
    ]);
    expect(outputTokens(windows[1]!)).toEqual([
      ["claude", 19],
      ["codex", 47],
    ]);
  });
});
