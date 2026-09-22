import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Credential path resolution is synchronous at this Promise adapter boundary.
import * as NodePath from "node:path";

import type { UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { cursorFileCredentialPath } from "./cursorCredentialPath.ts";

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
// Cursor stamps a row with its request's start and writes it when the request
// finishes. An hour comfortably outlasts one model request, so older rows are final.
const SETTLE_MS = 60 * 60 * 1000;
// The longest Usage window is 90 days, padded a day each side for time zones.
const RETAIN_MS = 93 * DAY_MS;

const nowMs = () => DateTime.toEpochMillis(Effect.runSync(DateTime.now));

function requestCache<T>() {
  const entries = new Map<string, { expires: number; value: Promise<T> }>();
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const now = nowMs();
    const previous = entries.get(key);
    if (previous && previous.expires > now) return previous.value;
    for (const [key, entry] of entries) if (entry.expires <= now) entries.delete(key);
    if (entries.size >= MAX_CACHE_ENTRIES) entries.delete(entries.keys().next().value ?? "");
    const value = run().catch((error: unknown) => {
      entries.delete(key);
      throw error;
    });
    entries.set(key, { expires: now + TTL_MS, value });
    return value;
  };
}

/** Inclusive epoch-millisecond bounds, as GetFilteredUsageEvents reads startDate and endDate. */
interface Span {
  readonly from: number;
  readonly until: number;
}
/** One API row. An unreadable row sits at its span's start so window reads still report it. */
interface Row {
  readonly timestamp: number;
  readonly event: CursorUsageEvent | null;
}
interface SpanRead {
  readonly span: Span;
  readonly rows: readonly Row[];
  /** Why some rows in the span went unread; null when the span was read completely. */
  readonly message: string | null;
}
/**
 * Every row Cursor reported for one account over one contiguous span. Rows up to
 * `settledUntil` are final; newer rows are trusted until `checkedAt + TTL_MS`.
 */
interface AccountHistory extends Span {
  readonly settledUntil: number;
  readonly checkedAt: number;
  readonly rows: readonly Row[];
}

/**
 * Splits off the unsettled tail. Pages are numbered newest first, so a new event
 * would shift every later page of a single span that reached the present.
 */
const splitAtSettled = (span: Span, now: number): Span[] =>
  [
    { from: span.from, until: Math.min(span.until, now - SETTLE_MS) },
    { from: Math.max(span.from, now - SETTLE_MS + 1), until: span.until },
  ].filter((part) => part.from <= part.until);

/** Spans to read so `history` plus them covers `window`, keeping coverage contiguous. */
function missingSpans(history: AccountHistory | undefined, window: Span, now: number): Span[] {
  if (!history) return splitAtSettled(window, now);
  const trustedUntil = now < history.checkedAt + TTL_MS ? history.until : history.settledUntil;
  return [
    ...(window.from < history.from ? [{ from: window.from, until: history.from - 1 }] : []),
    ...(window.until > trustedUntil
      ? splitAtSettled({ from: trustedUntil + 1, until: window.until }, now)
      : []),
  ];
}

/** A read span is authoritative for its whole range, so it replaces rather than appends. */
const replaceSpan = (rows: readonly Row[], read: SpanRead): readonly Row[] => [
  ...rows.filter((row) => row.timestamp < read.span.from || row.timestamp > read.span.until),
  ...read.rows,
];

/** Adds a completely read span. A span that would leave a hole is not recorded. */
function cover(
  history: AccountHistory | undefined,
  read: SpanRead,
  now: number,
): AccountHistory | undefined {
  const { span } = read;
  if (history && (span.from > history.until + 1 || span.until < history.from - 1)) return history;
  const base = history ?? { ...span, settledUntil: span.from - 1, checkedAt: now, rows: [] };
  return {
    from: Math.min(base.from, span.from),
    until: Math.max(base.until, span.until),
    settledUntil:
      span.from <= base.settledUntil + 1
        ? Math.max(base.settledUntil, Math.min(span.until, now - SETTLE_MS))
        : base.settledUntil,
    // Only a read of the whole unsettled tail vouches for it. A read that merely
    // extends the end would otherwise keep a late-written row out indefinitely.
    checkedAt:
      span.until >= base.until && span.from <= base.settledUntil + 1 ? now : base.checkedAt,
    rows: replaceSpan(base.rows, read),
  };
}

function retain(history: AccountHistory | undefined, now: number): AccountHistory | undefined {
  const floor = now - RETAIN_MS;
  if (!history || history.from >= floor) return history;
  if (history.until < floor) return undefined;
  return {
    ...history,
    from: floor,
    settledUntil: Math.max(history.settledUntil, floor - 1),
    rows: history.rows.filter((row) => row.timestamp >= floor),
  };
}

/** Reads existing credentials only. No token refresh, CLI execution, or fallback account. */
export function makeCursorDashboardReader(
  dependencies: {
    readonly fetch?: (url: string, options: RequestInit) => Promise<Response>;
    readonly readFile?: (path: string) => Promise<string>;
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const fetchApi = dependencies.fetch ?? fetch;
  const platform = dependencies.platform ?? HostProcessPlatform.defaultValue();
  const identities = requestCache<CursorAccount>();
  const histories = new Map<string, AccountHistory>();
  // One read per account at a time, so a concurrent repeat is served from the
  // first read's coverage instead of racing it to the API.
  const accountTurns = new Map<string, Promise<unknown>>();
  const exclusive = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const result = (accountTurns.get(key) ?? Promise.resolve()).then(run);
    accountTurns.set(
      key,
      result.catch(() => undefined),
    );
    return result;
  };

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
      const authPath = cursorFileCredentialPath(environment, platform);
      if (!NodePath.isAbsolute(authPath))
        throw new Error("Cursor credential directory is unavailable.");
      try {
        if (!read) throw new Error();
        token = decodeAuth(await read(authPath)).accessToken;
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
    const readSpan = async (
      account: CursorAccount,
      span: Span,
      signal: AbortSignal,
    ): Promise<SpanRead> => {
      const requestPage = async (page: number) =>
        decodePage(
          await request(
            "GetFilteredUsageEvents",
            {
              page,
              pageSize: PAGE_SIZE,
              startDate: String(span.from),
              endDate: String(span.until),
              ...(account.teamId === undefined ? {} : { teamId: account.teamId }),
            },
            signal,
          ),
        );
      const firstPage = await requestPage(1);
      const expected = firstPage.totalUsageEventsCount;
      const pages: Array<CursorPage | null> = [firstPage];
      let fetchedRows = firstPage.usageEventsDisplay?.length ?? 0;
      let laterPageFailed = false;
      for (let first = 2; first <= MAX_PAGES && fetchedRows < expected; first += PAGE_CONCURRENCY) {
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
      const rows: Row[] = [];
      let seen = 0;
      let message: string | null = null;
      for (const result of pages) {
        if (result === null) {
          message = "A later Cursor history page could not be read; totals are partial.";
          continue;
        }
        if (result.totalUsageEventsCount !== expected)
          message = "Cursor history changed during pagination; coverage may be incomplete.";
        const pageRows = result.usageEventsDisplay ?? [];
        for (const row of pageRows.slice(0, PAGE_SIZE)) {
          try {
            const event = decodeEvent(row);
            rows.push({ timestamp: Number(event.timestamp), event });
          } catch {
            rows.push({ timestamp: span.from, event: null });
          }
        }
        seen += pageRows.length;
        if (pageRows.length > PAGE_SIZE)
          message = "Cursor returned an oversized history page; coverage is incomplete.";
        if (seen > expected)
          message =
            "Cursor returned more requests than its reported count; coverage may be incomplete.";
      }
      if (seen < expected && !laterPageFailed)
        message = "Cursor history reached the read limit; coverage is incomplete.";
      return { span, rows, message };
    };
    return {
      identify,
      readHistory: async (input: UsageSummaryInput): Promise<CursorHistory> => {
        const account = await identify();
        const window: Span =
          input.resolution === "hour"
            ? { from: Date.parse(input.sinceTime ?? ""), until: Date.parse(input.untilTime ?? "") }
            : {
                from: Date.parse(`${input.sinceDay}T00:00:00Z`) - DAY_MS,
                until: Date.parse(`${input.untilDay}T00:00:00Z`) + 2 * DAY_MS,
              };
        return exclusive(account.sourceId, async () => {
          const now = nowMs();
          const cached = retain(histories.get(account.sourceId), now);
          const signal = AbortSignal.timeout(MAX_HISTORY_MS);
          const results = await Promise.allSettled(
            missingSpans(cached, window, now).map((span) => readSpan(account, span, signal)),
          );
          const reads = results.flatMap((result) =>
            result.status === "fulfilled" ? [result.value] : [],
          );
          const history = reads
            .filter((read) => read.message === null)
            .reduce<AccountHistory | undefined>(
              (current, read) => cover(current, read, now),
              cached,
            );
          if (history) histories.set(account.sourceId, history);
          else histories.delete(account.sourceId);
          if (reads.length < results.length)
            throw new Error("Cursor history could not be read for this account.");
          const rows = reads
            .reduce(replaceSpan, history?.rows ?? [])
            .filter((row) => row.timestamp >= window.from && row.timestamp <= window.until);
          const malformedRecords = rows.filter((row) => !row.event?.tokenUsage).length;
          const message =
            reads.find((read) => read.message !== null)?.message ??
            (malformedRecords > 0
              ? "Some Cursor requests did not include readable token usage; totals are partial."
              : null);
          return {
            events: rows.flatMap((row) => (row.event ? [row.event] : [])),
            status: message ? "partial" : "ok",
            message,
            malformedRecords,
            readAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          };
        });
      },
    };
  };
}

export const readCursorDashboard = makeCursorDashboardReader();
