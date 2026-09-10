import { UsageDay } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeCursorDashboardReader } from "./cursorDashboard.ts";
import me from "./testFixtures/cursor/me.json" with { type: "json" };
import period from "./testFixtures/cursor/period.json" with { type: "json" };
import events from "./testFixtures/cursor/events.json" with { type: "json" };

const input = {
  sinceDay: UsageDay.make("2026-09-09"),
  untilDay: UsageDay.make("2026-09-10"),
  timeZone: "America/New_York",
};
const environment = { CURSOR_AUTH_TOKEN: "test-access-token" };
const event = {
  timestamp: "1789044068921",
  model: "cursor-model",
  tokenUsage: { inputTokens: 3, totalCents: 25 },
};

function reader(responses: { period?: unknown; page?: (page: number) => unknown } = {}) {
  const requests: { method: string; body: unknown; authorization: string | null }[] = [];
  const fetchApi = async (url: string, options: RequestInit) => {
    const method = String(url).split("/").at(-1) ?? "";
    const body = JSON.parse(String(options?.body));
    requests.push({
      method,
      body,
      authorization: new Headers(options?.headers).get("Authorization"),
    });
    if (method === "GetMe") return Response.json(me);
    if (method === "GetCurrentPeriodUsage") return Response.json(responses.period ?? period);
    return Response.json(
      responses.page?.(body.page) ?? {
        totalUsageEventsCount: 2,
        usageEventsDisplay: events.usageEventsDisplay,
      },
    );
  };
  return { read: makeCursorDashboardReader({ fetch: fetchApi }), requests };
}

afterEach(() => vi.restoreAllMocks());

describe("Cursor dashboard", () => {
  it("reads the reported Auto/API pools and actual monthly reset, with a separate on-demand budget", async () => {
    const api = reader();
    const dashboard = await api.read(environment);
    const limits = await dashboard.currentPeriod();
    expect(limits.windows).toEqual([
      {
        id: "cursor_auto",
        kind: "monthly",
        label: "Auto",
        usedPercent: 74.42733333333334,
        resetsAt: "2026-09-11T16:26:43.000Z",
        windowDurationMins: 44640,
      },
      {
        id: "cursor_api",
        kind: "monthly",
        label: "API",
        usedPercent: 100,
        resetsAt: "2026-09-11T16:26:43.000Z",
        windowDurationMins: 44640,
      },
      {
        id: "cursor_ondemand",
        kind: "other",
        label: "On-demand",
        usedPercent: (2639 / 9900) * 100,
        budgetUsd: { used: 26.39, limit: 99 },
        resetsAt: "2026-09-11T16:26:43.000Z",
      },
    ]);
    expect(api.requests.map((request) => request.method)).toEqual([
      "GetMe",
      "GetCurrentPeriodUsage",
    ]);
  });

  it("keeps absent independent percentages unknown and never combines different on-demand budgets", async () => {
    const api = reader({
      period: {
        planUsage: { apiPercentUsed: 0 },
        spendLimitUsage: { individualUsed: 10, pooledLimit: 100 },
      },
    });
    expect((await (await api.read(environment)).currentPeriod()).windows).toEqual([
      { id: "cursor_api", label: "API", kind: "monthly", usedPercent: 0 },
    ]);
    expect(
      (await (await reader({ period: {} }).read(environment)).currentPeriod()).unavailable?.reason,
    ).toBe("probeFailed");
  });

  it("accepts omitted protobuf zero counts for an empty account", async () => {
    const dashboard = await reader({ page: () => ({}) }).read(environment);
    expect(await dashboard.readHistory(input)).toMatchObject({
      events: [],
      status: "ok",
      malformedRecords: 0,
    });
  });

  it("retains distinct identical requests and treats omitted token scalars as zero, not a missing payload", async () => {
    const api = reader({
      page: () => ({
        totalUsageEventsCount: 3,
        usageEventsDisplay: [event, event, { timestamp: event.timestamp, model: event.model }],
      }),
    });
    const history = await (await api.read(environment)).readHistory(input);
    expect(history.events).toHaveLength(3);
    expect(history.status).toBe("partial");
    expect(history.malformedRecords).toBe(1);
  });

  it("skips unsafe timestamps and reports partial coverage without aborting other usage", async () => {
    const dashboard = await reader({
      page: () => ({
        totalUsageEventsCount: 3,
        usageEventsDisplay: [
          event,
          { ...event, timestamp: "9".repeat(400) },
          { ...event, timestamp: "8640000000000001" },
        ],
      }),
    }).read(environment);
    expect(await dashboard.readHistory(input)).toMatchObject({
      events: [event],
      status: "partial",
      malformedRecords: 2,
    });
  });

  it("pages until the reported count and marks count drift or later errors partial", async () => {
    const stable = reader({
      page: () => ({ totalUsageEventsCount: 2, usageEventsDisplay: [event] }),
    });
    expect((await (await stable.read(environment)).readHistory(input)).events).toHaveLength(2);
    expect(
      stable.requests
        .filter((request) => request.method === "GetFilteredUsageEvents")
        .map((request) => request.body),
    ).toEqual([
      { page: 1, pageSize: 500, startDate: "1788825600000", endDate: "1789171200000" },
      { page: 2, pageSize: 500, startDate: "1788825600000", endDate: "1789171200000" },
    ]);
    const drift = reader({
      page: (page) => ({ totalUsageEventsCount: page === 1 ? 2 : 1, usageEventsDisplay: [event] }),
    });
    expect((await (await drift.read(environment)).readHistory(input)).status).toBe("partial");
    const failure = reader({
      page: (page) => {
        if (page > 1) throw new Error("private response");
        return { totalUsageEventsCount: 2, usageEventsDisplay: [event] };
      },
    });
    const result = await (await failure.read(environment)).readHistory(input);
    expect(result.events).toHaveLength(1);
    expect(result.message).toBe(
      "A later Cursor history page could not be read; totals are partial.",
    );
  });

  it("bounds reads at 40 pages and retries partial reads", async () => {
    const api = reader({
      page: () => ({ totalUsageEventsCount: 99999, usageEventsDisplay: [event] }),
    });
    const dashboard = await api.read(environment);
    expect(await dashboard.readHistory(input)).toMatchObject({
      status: "partial",
      events: Array.from({ length: 40 }, () => event),
    });
    await dashboard.readHistory(input);
    expect(
      api.requests.filter((request) => request.method === "GetFilteredUsageEvents"),
    ).toHaveLength(80);
  });

  it("bounds the whole history deadline and keeps completed pages on cancellation", async () => {
    const deadline = new AbortController();
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      timeouts.push(ms);
      return ms === 30000 ? deadline.signal : new AbortController().signal;
    });
    let pages = 0;
    const read = makeCursorDashboardReader({
      fetch: async (url, options) => {
        options?.signal?.throwIfAborted();
        if (String(url).endsWith("GetMe")) return Response.json(me);
        pages++;
        deadline.abort();
        return Response.json({ totalUsageEventsCount: 2, usageEventsDisplay: [event] });
      },
    });
    expect(await (await read(environment)).readHistory(input)).toMatchObject({
      status: "partial",
      events: [event],
    });
    expect(pages).toBe(1);
    expect(timeouts).toContain(30000);
    expect(timeouts.filter((ms) => ms === 8000)).toHaveLength(3);
  });

  it("coalesces history by authoritative account across credential aliases and expires the cache", async () => {
    vi.useFakeTimers();
    try {
      const api = reader();
      const [first, second] = await Promise.all([
        api.read(environment),
        api.read({ CURSOR_AUTH_TOKEN: "another-token" }),
      ]);
      const [a, b] = await Promise.all([first.readHistory(input), second.readHistory(input)]);
      expect(a).toBe(b);
      expect(
        api.requests.filter((request) => request.method === "GetFilteredUsageEvents"),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60001);
      await first.readHistory(input);
      expect(
        api.requests.filter((request) => request.method === "GetFilteredUsageEvents"),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates credential files, explicit tokens and API origins without fallback or refresh", async () => {
    const files: string[] = [];
    const calls: { url: string; authorization: string | null; redirect: string | undefined }[] = [];
    const read = makeCursorDashboardReader({
      readFile: async (file) => {
        files.push(file);
        if (file.startsWith("/absent/")) throw new Error("secret");
        return JSON.stringify({ accessToken: file });
      },
      fetch: async (url, options) => {
        calls.push({
          url: String(url),
          authorization: new Headers(options?.headers).get("Authorization"),
          redirect: options?.redirect,
        });
        return Response.json(me);
      },
    });
    const first = await (
      await read({ HOME: "/first", AGENT_CLI_CREDENTIAL_STORE: "file" })
    ).identify();
    const second = await (
      await read({
        HOME: "/second",
        CURSOR_CONFIG_DIR: "/profile",
        AGENT_CLI_CREDENTIAL_STORE: "file",
      })
    ).identify();
    expect(first.sourceId).toBe(second.sourceId);
    const custom = await (
      await read({
        CURSOR_AUTH_TOKEN: "explicit-token",
        CURSOR_API_ENDPOINT: "https://example.com:443/",
      })
    ).identify();
    expect(custom.sourceId).not.toBe(first.sourceId);
    expect(files).toEqual(["/first/.cursor/auth.json", "/profile/auth.json"]);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer /first/.cursor/auth.json",
      "Bearer /profile/auth.json",
      "Bearer explicit-token",
    ]);
    expect(calls.every((call) => call.redirect === "error")).toBe(true);
    await expect(read({ HOME: "/absent", AGENT_CLI_CREDENTIAL_STORE: "file" })).rejects.toThrow(
      "Cursor credentials could not be read for this instance.",
    );
    await expect(read({ HOME: "/first" })).rejects.toThrow("file credential store");
    await expect(
      read({ CURSOR_AUTH_TOKEN: "secret", CURSOR_API_ENDPOINT: "http://example.com" }),
    ).rejects.toThrow("HTTPS origin");
    expect(calls).toHaveLength(3);
  });

  it("does not refresh expired auth and distinguishes account team contexts", async () => {
    const failed = makeCursorDashboardReader({
      fetch: async () => new Response("secret", { status: 401 }),
    });
    await expect((await failed(environment)).identify()).rejects.toThrow(
      "Cursor dashboard request failed.",
    );
    const team = makeCursorDashboardReader({
      fetch: async (_url, options) =>
        Response.json({
          ...me,
          teamId: new Headers(options?.headers).get("Authorization") === "Bearer a" ? 1 : 2,
        }),
    });
    const first = await (await team({ CURSOR_AUTH_TOKEN: "a" })).identify();
    const second = await (await team({ CURSOR_AUTH_TOKEN: "b" })).identify();
    expect(first.sourceId).not.toBe(second.sourceId);
  });
});
