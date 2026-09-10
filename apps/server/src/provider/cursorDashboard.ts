import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Credential path resolution is synchronous at this Promise adapter boundary.
import * as NodePath from "node:path";

import { type ServerProviderUsageLimits, type UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Count = NonNegative.check(Schema.isInt());
const Identifier = Schema.Union([Schema.String, Schema.Finite]);
const Me = Schema.Struct({
  authId: Schema.NonEmptyString,
  userId: Count,
  email: Schema.optional(Schema.String),
  teamId: Schema.optional(Identifier),
  organizationId: Schema.optional(Identifier),
  isEnterpriseUser: Schema.optional(Schema.Boolean),
});
const Period = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.String),
  billingCycleEnd: Schema.optional(Schema.String),
  planUsage: Schema.optional(
    Schema.Struct({
      autoPercentUsed: Schema.optional(NonNegative),
      apiPercentUsed: Schema.optional(NonNegative),
    }),
  ),
  spendLimitUsage: Schema.optional(
    Schema.Struct({
      individualUsed: Schema.optional(NonNegative),
      individualLimit: Schema.optional(NonNegative),
      pooledUsed: Schema.optional(NonNegative),
      pooledLimit: Schema.optional(NonNegative),
    }),
  ),
});
export const CursorUsageEvent = Schema.Struct({
  timestamp: Schema.String.check(
    Schema.isPattern(/^\d+$/),
    Schema.makeFilter(
      (value) => Number.isSafeInteger(Number(value)) && Number(value) <= 8_640_000_000_000_000,
    ),
  ),
  model: Schema.NonEmptyString,
  conversationId: Schema.optional(Schema.String),
  tokenUsage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(Count),
      outputTokens: Schema.optional(Count),
      cacheReadTokens: Schema.optional(Count),
      cacheWriteTokens: Schema.optional(Count),
      totalCents: Schema.optional(NonNegative),
    }),
  ),
});
export type CursorUsageEvent = typeof CursorUsageEvent.Type;
const Page = Schema.Struct({
  totalUsageEventsCount: Count.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  usageEventsDisplay: Schema.optional(Schema.Array(Schema.Unknown)),
});
type CursorPage = typeof Page.Type;
const AuthFile = Schema.Struct({ accessToken: Schema.NonEmptyString });
const decodeAuth = Schema.decodeUnknownSync(Schema.fromJsonString(AuthFile));
const decodeMe = Schema.decodeUnknownSync(Me);
const decodePeriod = Schema.decodeUnknownSync(Period);
const decodePage = Schema.decodeUnknownSync(Page);
const decodeEvent = Schema.decodeUnknownSync(CursorUsageEvent);

export interface CursorAccount {
  readonly sourceId: string;
  readonly email?: string;
  readonly teamId?: string | number;
}
export interface CursorHistory {
  readonly events: readonly CursorUsageEvent[];
  readonly status: "ok" | "partial";
  readonly message: string | null;
  readonly malformedRecords: number;
  readonly readAt: string;
}

const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 128;
const PAGE_SIZE = 500;
const MAX_PAGES = 40;
const PAGE_CONCURRENCY = 4;
const MAX_HISTORY_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function requestCache<T>(keep: (value: T) => boolean = () => true) {
  const entries = new Map<string, { expires: number; value: Promise<T> }>();
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const now = DateTime.toEpochMillis(Effect.runSync(DateTime.now));
    const previous = entries.get(key);
    if (previous && previous.expires > now) return previous.value;
    for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key);
    if (entries.size >= MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value ?? "");
    const value = run()
      .then((result) => {
        if (!keep(result)) entries.delete(key);
        return result;
      })
      .catch((error: unknown) => {
        entries.delete(key);
        throw error;
      });
    entries.set(key, { expires: now + TTL_MS, value });
    return value;
  };
}

/** Reads existing credentials only. No token refresh, CLI execution, or fallback account. */
export function makeCursorDashboardReader(
  dependencies: {
    readonly fetch?: (url: string, options: RequestInit) => Promise<Response>;
    readonly readFile?: (path: string) => Promise<string>;
  } = {},
) {
  const fetchApi = dependencies.fetch ?? fetch;
  const identities = requestCache<CursorAccount>();
  const periods = requestCache<ServerProviderUsageLimits>();
  const histories = requestCache<CursorHistory>((history) => history.status === "ok");

  return async (environment: NodeJS.ProcessEnv, read = dependencies.readFile) => {
    let apiUrl: URL;
    try {
      apiUrl = new URL(
        environment.CURSOR_API_ENDPOINT ||
          environment.CURSOR_API_BASE_URL ||
          "https://api2.cursor.sh",
      );
      if (
        apiUrl.protocol !== "https:" ||
        apiUrl.username ||
        apiUrl.password ||
        apiUrl.search ||
        apiUrl.hash ||
        apiUrl.pathname !== "/"
      )
        throw new Error();
    } catch {
      throw new Error("Cursor API endpoint must be an HTTPS origin.");
    }
    const origin = apiUrl.origin;
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    if (!token) {
      if (environment.AGENT_CLI_CREDENTIAL_STORE !== "file") {
        throw new Error(
          "Cursor usage requires the file credential store or an explicit access token.",
        );
      }
      const configDir =
        environment.CURSOR_CONFIG_DIR ||
        (environment.XDG_CONFIG_HOME
          ? NodePath.join(environment.XDG_CONFIG_HOME, "cursor")
          : environment.HOME
            ? NodePath.join(environment.HOME, ".cursor")
            : undefined);
      if (!configDir || !NodePath.isAbsolute(configDir))
        throw new Error("Cursor credential directory is unavailable.");
      try {
        if (!read) throw new Error();
        token = decodeAuth(await read(NodePath.join(configDir, "auth.json"))).accessToken;
      } catch {
        throw new Error("Cursor credentials could not be read for this instance.");
      }
    }
    const accessToken = token;
    const credentialKey = digest([origin, accessToken]);
    const request = async (
      method: string,
      body: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      try {
        const response = await fetchApi(`${origin}/aiserver.v1.DashboardService/${method}`, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
          },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
            : AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error();
        return await response.json();
      } catch {
        throw new Error(
          "Cursor dashboard request failed. Check this instance's existing login and API endpoint.",
        );
      }
    };
    const identify = () =>
      identities(credentialKey, async () => {
        const me = decodeMe(await request("GetMe", {}));
        if (me.isEnterpriseUser)
          throw new Error("Cursor enterprise usage is not supported by this reader.");
        return {
          sourceId: digest([
            origin,
            me.authId,
            me.userId,
            me.teamId ?? null,
            me.organizationId ?? null,
          ]),
          ...(me.email ? { email: me.email } : {}),
          ...(me.teamId !== undefined ? { teamId: me.teamId } : {}),
        };
      });
    return {
      identify,
      currentPeriod: async () => {
        const account = await identify();
        return periods(account.sourceId, async () => {
          const raw = decodePeriod(await request("GetCurrentPeriodUsage", {}));
          const end = Number(raw.billingCycleEnd);
          const start = Number(raw.billingCycleStart);
          const resetsAt =
            Number.isFinite(end) && end > 0
              ? DateTime.formatIso(DateTime.makeUnsafe(end))
              : undefined;
          const duration =
            Number.isFinite(start) && end > start ? Math.round((end - start) / 60000) : undefined;
          const windows: ServerProviderUsageLimits["windows"][number][] = [];
          for (const [id, label, percent] of [
            ["cursor_auto", "Auto", raw.planUsage?.autoPercentUsed],
            ["cursor_api", "API", raw.planUsage?.apiPercentUsed],
          ] as const) {
            if (percent === undefined) continue;
            windows.push({
              id,
              label,
              kind: "monthly",
              usedPercent: Math.min(100, percent),
              ...(resetsAt ? { resetsAt } : {}),
              ...(duration ? { windowDurationMins: duration } : {}),
            });
          }
          const spend = raw.spendLimitUsage;
          const budget =
            spend?.individualUsed !== undefined && spend.individualLimit !== undefined
              ? { used: spend.individualUsed, limit: spend.individualLimit }
              : spend?.pooledUsed !== undefined && spend.pooledLimit !== undefined
                ? { used: spend.pooledUsed, limit: spend.pooledLimit }
                : null;
          const used = budget?.used;
          const limit = budget?.limit;
          if (used !== undefined && limit !== undefined && limit > 0) {
            windows.push({
              id: "cursor_ondemand",
              label: "On-demand",
              budgetUsd: { used: used / 100, limit: limit / 100 },
              kind: "other",
              usedPercent: Math.min(100, (used / limit) * 100),
              ...(resetsAt ? { resetsAt } : {}),
            });
          }
          return {
            checkedAt: DateTime.formatIso(Effect.runSync(DateTime.now)),
            windows,
            ...(windows.length === 0
              ? {
                  unavailable: {
                    reason: "probeFailed" as const,
                    message: "Cursor did not report usable plan limits.",
                  },
                }
              : {}),
          };
        });
      },
      readHistory: async (input: UsageSummaryInput): Promise<CursorHistory> => {
        const account = await identify();
        return histories(JSON.stringify([account.sourceId, input]), async () => {
          const startDate =
            input.resolution === "hour"
              ? Date.parse(input.sinceTime ?? "")
              : Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS;
          const endDate =
            input.resolution === "hour"
              ? Date.parse(input.untilTime ?? "")
              : Date.parse(`${input.untilDay}T00:00:00Z`) + 2 * DAY_MS;
          const signal = AbortSignal.timeout(MAX_HISTORY_MS);
          const events: CursorUsageEvent[] = [];
          let expected: number;
          let seen = 0;
          let malformedRecords = 0;
          let message: string | null = null;
          const requestPage = async (page: number) =>
            decodePage(
              await request(
                "GetFilteredUsageEvents",
                {
                  page,
                  pageSize: PAGE_SIZE,
                  startDate: String(startDate),
                  endDate: String(endDate),
                  ...(account.teamId === undefined ? {} : { teamId: account.teamId }),
                },
                signal,
              ),
            );
          let firstPage: CursorPage;
          try {
            firstPage = await requestPage(1);
          } catch {
            throw new Error("Cursor history could not be read for this account.");
          }
          expected = firstPage.totalUsageEventsCount;
          const pages: Array<CursorPage | null> = [firstPage];
          let fetchedRows = firstPage.usageEventsDisplay?.length ?? 0;
          let laterPageFailed = false;
          for (
            let first = 2;
            first <= MAX_PAGES && fetchedRows < expected;
            first += PAGE_CONCURRENCY
          ) {
            const batchSize = Math.min(
              PAGE_CONCURRENCY,
              MAX_PAGES - first + 1,
              Math.max(1, expected - fetchedRows),
            );
            const batch = await Promise.all(
              Array.from({ length: batchSize }, (_, i) => requestPage(first + i).catch(() => null)),
            );
            pages.push(...batch);
            for (const page of batch) {
              if (page === null) laterPageFailed = true;
              else fetchedRows += page.usageEventsDisplay?.length ?? 0;
            }
            if (laterPageFailed) break;
          }
          for (const result of pages) {
            if (result === null) {
              message = "A later Cursor history page could not be read; totals are partial.";
              continue;
            }
            if (result.totalUsageEventsCount !== expected)
              message = "Cursor history changed during pagination; coverage may be incomplete.";
            const rows = result.usageEventsDisplay ?? [];
            for (const row of rows.slice(0, PAGE_SIZE)) {
              try {
                const event = decodeEvent(row);
                if (!event.tokenUsage) malformedRecords++;
                events.push(event);
              } catch {
                malformedRecords++;
              }
            }
            seen += rows.length;
            if (rows.length > PAGE_SIZE)
              message = "Cursor returned an oversized history page; coverage is incomplete.";
            if (seen > expected)
              message =
                "Cursor returned more requests than its reported count; coverage may be incomplete.";
          }
          if (seen < expected && !laterPageFailed)
            message = "Cursor history reached the read limit; coverage is incomplete.";
          if (malformedRecords > 0)
            message ??=
              "Some Cursor requests did not include readable token usage; totals are partial.";
          return {
            events,
            status: message ? "partial" : "ok",
            message,
            malformedRecords,
            readAt: DateTime.formatIso(Effect.runSync(DateTime.now)),
          };
        });
      },
    };
  };
}

export const readCursorDashboard = makeCursorDashboardReader();
