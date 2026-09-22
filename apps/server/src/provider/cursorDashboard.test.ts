// @effect-diagnostics nodeBuiltinImport:off - credential fixtures use isolated temporary homes.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { makeCursorDashboardReader, type CursorHistory } from "./cursorDashboard.ts";
import me from "./testFixtures/cursor/me.json" with { type: "json" };
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

function reader(responses: { page?: (page: number) => unknown } = {}) {
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

  it("fetches remaining history pages concurrently after the first page", async () => {
    let active = 0;
    let maxActive = 0;
    const api = makeCursorDashboardReader({
      fetch: async (url) => {
        if (String(url).endsWith("GetMe")) return Response.json(me);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return Response.json({ totalUsageEventsCount: 4, usageEventsDisplay: [event] });
      },
    });

    const history = await (await api(environment)).readHistory(input);
    expect(history.events).toHaveLength(4);
    expect(maxActive).toBe(3);
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

  it("shares history by authoritative account across credential aliases and keeps settled history", async () => {
    vi.useFakeTimers();
    try {
      const api = reader();
      const [first, second] = await Promise.all([
        api.read(environment),
        api.read({ CURSOR_AUTH_TOKEN: "another-token" }),
      ]);
      const [a, b] = await Promise.all([first.readHistory(input), second.readHistory(input)]);
      expect(a.events).toHaveLength(2);
      expect(b.events).toEqual(a.events);
      expect(
        api.requests.filter((request) => request.method === "GetFilteredUsageEvents"),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60001);
      await first.readHistory(input);
      expect(
        api.requests.filter((request) => request.method === "GetFilteredUsageEvents"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates credential files, explicit tokens and API origins without fallback or refresh", async () => {
    const files: string[] = [];
    const calls: { url: string; authorization: string | null; redirect: string | undefined }[] = [];
    const read = makeCursorDashboardReader({
      platform: "darwin",
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
    expect(files).toEqual(["/first/.cursor/auth.json", "/second/.cursor/auth.json"]);
    expect(calls.map((call) => call.authorization)).toEqual([
      "Bearer /first/.cursor/auth.json",
      "Bearer /second/.cursor/auth.json",
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

  it("identifies the Darwin home account when an unrelated CLI config has valid generic auth", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cursor-dashboard-"));
    try {
      const configDir = NodePath.join(directory, ".config/cursor");
      await NodeFSP.mkdir(configDir, { recursive: true });
      await NodeFSP.mkdir(NodePath.join(directory, ".cursor"));
      await NodeFSP.writeFile(
        NodePath.join(directory, ".cursor/auth.json"),
        '{"accessToken":"selected-token"}',
      );
      await NodeFSP.writeFile(
        NodePath.join(configDir, "auth.json"),
        '{"accessToken":"generic-token"}',
      );
      const read = makeCursorDashboardReader({
        platform: "darwin",
        readFile: (path) => NodeFSP.readFile(path, "utf8"),
        fetch: async (_url, options) =>
          Response.json({
            ...me,
            email:
              new Headers(options.headers).get("Authorization") === "Bearer selected-token"
                ? "selected@example.test"
                : "generic@example.test",
          }),
      });
      const dashboard = await read({
        HOME: directory,
        CURSOR_CONFIG_DIR: configDir,
        AGENT_CLI_CREDENTIAL_STORE: "file",
      });
      expect((await dashboard.identify()).email).toBe("selected@example.test");
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
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

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const usage = (timestamp: string, inputTokens = 1) => ({
  timestamp: String(at(timestamp)),
  model: "cursor-model",
  tokenUsage: { inputTokens },
});
const hours = (sinceTime: string, untilTime: string): UsageSummaryInput => ({
  sinceDay: UsageDay.make(sinceTime.slice(0, 10)),
  untilDay: UsageDay.make(untilTime.slice(0, 10)),
  timeZone: "UTC",
  resolution: "hour",
  sinceTime,
  untilTime,
});

/** A Cursor API over `store`: inclusive date filter, newest first, page-numbered. */
function historyApi(
  store: Array<Record<string, unknown> & { timestamp: string }>,
  fails: (request: string) => boolean = () => false,
) {
  const requests: string[] = [];
  const read = makeCursorDashboardReader({
    fetch: async (url, options) => {
      if (String(url).endsWith("GetMe")) return Response.json(me);
      const body = JSON.parse(String(options.body));
      const request = `${iso(Number(body.startDate))}..${iso(Number(body.endDate))} #${body.page}`;
      requests.push(request);
      if (fails(request)) return new Response("unavailable", { status: 503 });
      const rows = store
        .filter(
          (row) =>
            Number(row.timestamp) >= Number(body.startDate) &&
            Number(row.timestamp) <= Number(body.endDate),
        )
        .toSorted((a, b) => Number(b.timestamp) - Number(a.timestamp));
      return Response.json({
        totalUsageEventsCount: rows.length,
        usageEventsDisplay: rows.slice((body.page - 1) * body.pageSize, body.page * body.pageSize),
      });
    },
  });
  return { dashboard: () => read(environment), requests };
}

const inputTokens = (history: CursorHistory) =>
  history.events.map((event) => event.tokenUsage?.inputTokens ?? -1).toSorted((a, b) => a - b);

describe("Cursor history cache", () => {
  afterEach(() => vi.useRealTimers());
  const week = hours("2026-09-03T12:00:00.000Z", "2026-09-10T12:00:00.000Z");

  it("serves a repeated window, including concurrent repeats, without new page requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-09-10T12:00:00.000Z") });
    const api = historyApi([
      usage("2026-09-05T00:00:00.000Z", 1),
      usage("2026-09-10T11:30:00.000Z", 2),
    ]);
    const dashboard = await api.dashboard();
    expect(inputTokens(await dashboard.readHistory(week))).toEqual([1, 2]);
    expect(api.requests).toEqual([
      "2026-09-03T12:00:00.000Z..2026-09-10T11:00:00.000Z #1",
      "2026-09-10T11:00:00.001Z..2026-09-10T12:00:00.000Z #1",
    ]);
    const [again, concurrent] = await Promise.all([
      dashboard.readHistory(week),
      dashboard.readHistory(week),
    ]);
    expect(inputTokens(again)).toEqual([1, 2]);
    expect(inputTokens(concurrent)).toEqual([1, 2]);
    expect(api.requests).toHaveLength(2);
  });

  it("fetches only the older gap when a window widens", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-09-10T12:00:00.000Z") });
    const api = historyApi([
      usage("2026-08-20T00:00:00.000Z", 1),
      usage("2026-09-05T00:00:00.000Z", 2),
    ]);
    const dashboard = await api.dashboard();
    await dashboard.readHistory(week);
    const month = await dashboard.readHistory(
      hours("2026-08-11T12:00:00.000Z", "2026-09-10T12:00:00.000Z"),
    );
    expect(inputTokens(month)).toEqual([1, 2]);
    expect(api.requests.slice(2)).toEqual([
      "2026-08-11T12:00:00.000Z..2026-09-03T11:59:59.999Z #1",
    ]);
  });

  it("later refetches only the unsettled tail and counts a refetched event once", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-09-10T12:00:00.000Z") });
    const store = [usage("2026-09-05T00:00:00.000Z", 1), usage("2026-09-10T11:30:00.000Z", 2)];
    const api = historyApi(store);
    const dashboard = await api.dashboard();
    await dashboard.readHistory(week);
    vi.setSystemTime(at("2026-09-10T12:10:00.000Z"));
    store.push(usage("2026-09-10T12:05:00.000Z", 3));
    const later = await dashboard.readHistory(
      hours("2026-09-03T12:10:00.000Z", "2026-09-10T12:10:00.000Z"),
    );
    expect(inputTokens(later)).toEqual([1, 2, 3]);
    expect(api.requests.slice(2)).toEqual([
      "2026-09-10T11:00:00.001Z..2026-09-10T11:10:00.000Z #1",
      "2026-09-10T11:10:00.001Z..2026-09-10T12:10:00.000Z #1",
    ]);
  });

  it("refetches the unsettled hour once a minute even when reads keep extending the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-09-10T12:00:00.000Z") });
    const store = [usage("2026-09-10T11:30:00.000Z", 1)];
    const api = historyApi(store);
    const dashboard = await api.dashboard();
    const pastDay = (until: string) =>
      hours(new Date(at(until) - 24 * 60 * 60 * 1000).toISOString(), until);
    await dashboard.readHistory(pastDay("2026-09-10T12:00:00.000Z"));
    // A request that started at 11:50 is written only after the first read.
    store.push(usage("2026-09-10T11:50:00.000Z", 2));
    vi.setSystemTime(at("2026-09-10T12:00:58.000Z"));
    expect(inputTokens(await dashboard.readHistory(pastDay("2026-09-10T12:00:58.000Z")))).toEqual([
      1,
    ]);
    vi.setSystemTime(at("2026-09-10T12:01:56.000Z"));
    expect(inputTokens(await dashboard.readHistory(pastDay("2026-09-10T12:01:56.000Z")))).toEqual([
      1, 2,
    ]);
  });

  it("caches settled history whose rows lack token usage", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-09-10T12:00:00.000Z") });
    const api = historyApi([
      usage("2026-09-05T00:00:00.000Z", 1),
      { timestamp: String(at("2026-09-06T00:00:00.000Z")), model: "cursor-model" },
    ]);
    const dashboard = await api.dashboard();
    const past = hours("2026-09-04T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    await dashboard.readHistory(past);
    const again = await dashboard.readHistory(past);
    expect(again).toMatchObject({ status: "partial", malformedRecords: 1 });
    expect(inputTokens(again)).toEqual([-1, 1]);
    expect(api.requests).toEqual(["2026-09-04T00:00:00.000Z..2026-09-08T00:00:00.000Z #1"]);
  });

  it("does not treat a span with a failed later page as covered", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-09-10T12:00:00.000Z") });
    let failing = true;
    const api = historyApi(
      Array.from({ length: 501 }, (_, i) => usage("2026-09-05T00:00:00.000Z", i)),
      (request) => failing && request.endsWith("#2"),
    );
    const dashboard = await api.dashboard();
    const past = hours("2026-09-04T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    expect(await dashboard.readHistory(past)).toMatchObject({
      status: "partial",
      message: "A later Cursor history page could not be read; totals are partial.",
    });
    failing = false;
    const retried = await dashboard.readHistory(past);
    expect(retried).toMatchObject({ status: "ok" });
    expect(retried.events).toHaveLength(501);
    expect(api.requests.slice(2)).toEqual([
      "2026-09-04T00:00:00.000Z..2026-09-08T00:00:00.000Z #1",
      "2026-09-04T00:00:00.000Z..2026-09-08T00:00:00.000Z #2",
    ]);
    await dashboard.readHistory(past);
    expect(api.requests).toHaveLength(4);
  });
});
