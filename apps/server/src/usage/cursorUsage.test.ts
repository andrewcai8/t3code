import { ProviderInstanceConfigMap, UsageDay, UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makeCursorDashboardReader } from "../provider/cursorDashboard.ts";
import me from "../provider/testFixtures/cursor/me.json" with { type: "json" };
import events from "../provider/testFixtures/cursor/events.json" with { type: "json" };
import { readCursorUsage } from "./cursorUsage.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable } from "./usagePricing.ts";

const decodeInstances = Schema.decodeUnknownSync(ProviderInstanceConfigMap);

const input = {
  sinceDay: UsageDay.make("2026-09-10"),
  untilDay: UsageDay.make("2026-09-10"),
  timeZone: "UTC",
};
const instance = (token: string) => ({
  driver: "cursor",
  environment: [{ name: "CURSOR_AUTH_TOKEN", value: token }],
});

function setup(rows: readonly unknown[] = events.usageEventsDisplay) {
  const historyCalls: string[] = [];
  const dashboard = makeCursorDashboardReader({
    fetch: async (url, options) => {
      const token = new Headers(options?.headers).get("Authorization") ?? "";
      if (String(url).endsWith("GetMe"))
        return Response.json({ ...me, authId: token.endsWith("alias") ? "Bearer a" : token });
      historyCalls.push(token);
      return Response.json({ totalUsageEventsCount: rows.length, usageEventsDisplay: rows });
    },
  });
  return { dashboard, historyCalls };
}

async function aggregate(instances: unknown, api = setup(), window: UsageSummaryInput = input) {
  const aggregator = new UsageAggregator({
    ...window,
    resolution: window.resolution ?? "day",
    rates: new Map(),
    priceOverrides: createOverrideRateTable({
      "grok-bot-default": { inputCostPerMillionTokens: 999999, outputCostPerMillionTokens: 999999 },
    }),
    ...(window.resolution === "hour"
      ? {
          sinceTimeMs: Date.parse(window.sinceTime ?? ""),
          untilTimeMs: Date.parse(window.untilTime ?? ""),
        }
      : {}),
  });
  const sources = await readCursorUsage({
    instances: decodeInstances(instances),
    environment: { HOME: "/base", CURSOR_AUTH_TOKEN: "base-token" },
    input: window,
    readFile: async () => {
      throw new Error("No credentials for this instance");
    },
    aggregator,
    dashboard: api.dashboard,
  });
  return { sources, buckets: aggregator.finish().buckets, historyCalls: api.historyCalls };
}

describe("Cursor usage contribution", () => {
  it("sums the sanitized API fixture, ignoring custom prices and counting known conversations only", async () => {
    const result = await aggregate({ cursor: instance("a") });
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      provider: "cursor",
      model: "grok-bot-default",
      totals: {
        uncachedInputTokens: 76950,
        outputTokens: 332,
        cachedInputTokens: 77312,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
      costSource: "providerReported",
      cacheSavingsUsd: 0,
      records: 2,
      sessions: 1,
    });
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.391088, 12);
    expect(result.sources[0]?.distinctSessions).toBe(1);
    expect(result.sources[0]?.fingerprint).toMatchObject({ kind: "account", provider: "cursor" });
  });

  it("deduplicates local aliases before history calls and keeps distinct accounts", async () => {
    const result = await aggregate({
      a: instance("a"),
      alias: instance("alias"),
      b: instance("b"),
      disabled: { ...instance("disabled"), enabled: false },
    });
    expect(result.historyCalls).toEqual(["Bearer a", "Bearer b"]);
    expect(result.sources).toHaveLength(2);
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.records, 0)).toBe(4);
  });

  it("uses the resolved per-instance secret value and never falls back after a file read failure", async () => {
    const result = await aggregate({
      secret: {
        driver: "cursor",
        environment: [{ name: "CURSOR_AUTH_TOKEN", value: "materialized-secret", sensitive: true }],
      },
      absent: {
        driver: "cursor",
        environment: [
          { name: "CURSOR_AUTH_TOKEN", value: "" },
          { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file" },
          { name: "CURSOR_CONFIG_DIR", value: "/absent" },
        ],
      },
    });
    expect(result.historyCalls).toEqual(["Bearer materialized-secret"]);
    expect(result.sources.map((source) => source.status)).toEqual(["ok", "failed"]);
  });

  it("replaces a partial local alias with a complete copy before adding records", async () => {
    const row = { timestamp: "1789044068921", model: "model", tokenUsage: { inputTokens: 10 } };
    const dashboard = makeCursorDashboardReader({
      fetch: async (url, options) => {
        if (String(url).endsWith("GetMe")) return Response.json(me);
        if (new Headers(options?.headers).get("Authorization") === "Bearer b")
          return Response.json({ totalUsageEventsCount: 1, usageEventsDisplay: [row] });
        if (JSON.parse(String(options?.body)).page > 1)
          return new Response("unavailable", { status: 503 });
        return Response.json({ totalUsageEventsCount: 2, usageEventsDisplay: [row] });
      },
    });
    const result = await aggregate(
      { a: instance("a"), b: instance("b") },
      { dashboard, historyCalls: [] },
    );
    expect(result.sources.map((source) => source.status)).toEqual(["ok"]);
    expect(result.buckets[0]).toMatchObject({
      records: 1,
      sessions: 0,
      totals: { uncachedInputTokens: 10 },
    });
    expect(result.sources[0]?.distinctSessions).toBe(0);
  });

  it("bins local-day boundaries and exact rolling-hour bounds without fabricated sessions", async () => {
    const rows = [
      "2026-09-10T03:29:59Z",
      "2026-09-10T03:30:00Z",
      "2026-09-10T04:29:59Z",
      "2026-09-10T04:30:00Z",
    ].map((timestamp) => ({
      timestamp: String(Date.parse(timestamp)),
      model: "model",
      tokenUsage: { inputTokens: 1 },
    }));
    const daily = await aggregate({ a: instance("a") }, setup(rows), {
      ...input,
      timeZone: "America/New_York",
    });
    expect(daily.buckets.map((bucket) => [bucket.day, bucket.records])).toEqual([
      ["2026-09-10", 2],
    ]);
    const hourly = await aggregate({ a: instance("a") }, setup(rows), {
      ...input,
      timeZone: "America/New_York",
      resolution: "hour",
      sinceTime: "2026-09-10T03:30:00Z",
      untilTime: "2026-09-10T04:30:00Z",
    });
    expect(
      hourly.buckets.map((bucket) => [
        bucket.day,
        bucket.hourStart,
        bucket.records,
        bucket.sessions,
      ]),
    ).toEqual([
      ["2026-09-09", "2026-09-10T03:30:00.000Z", 1, 0],
      ["2026-09-10", "2026-09-10T03:30:00.000Z", 1, 0],
    ]);
    expect(hourly.sources[0]?.distinctSessions).toBe(0);
  });
});
