/**
 * Keeps each Cursor account's settled usage history between scans.
 *
 * `readCursorAccountUsage` pages through the whole window on every call, and a
 * 30-day window on a busy account is tens of pages. Rows older than an hour
 * never change, so they are kept and only the unsettled tail is read again.
 *
 * @module cursorAccountHistory
 */
import { readCursorAccountUsage, type CursorAccountUsageReadResult } from "./cursorUsageReader.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

export type CursorCredentialSource = string | { readonly kind: "keychain" };

type ReadAccount = (
  credentialSource: CursorCredentialSource,
  sinceMs: number,
  untilMs: number,
) => Promise<CursorAccountUsageReadResult>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A fresh read of the unsettled tail is trusted this long. */
const TTL_MS = 60_000;
// Cursor stamps a row with its request's start and writes it when the request
// finishes. An hour comfortably outlasts one model request, so older rows are final.
const SETTLE_MS = 60 * 60 * 1000;
// The longest Usage window is 90 days, padded for the scan's mtime slack.
const RETAIN_MS = 93 * DAY_MS;

/** Inclusive epoch-millisecond bounds, as the dashboard reads startDate and endDate. */
interface Span {
  readonly from: number;
  readonly until: number;
}

/**
 * One account's records over one contiguous span. Records up to `settledUntil`
 * are final; newer ones are trusted until `checkedAt + TTL_MS`.
 */
interface AccountHistory extends Span {
  readonly accountKey: string;
  readonly settledUntil: number;
  readonly checkedAt: number;
  readonly records: readonly UsageRecord[];
}

/**
 * Splits off the unsettled tail. Pages are numbered newest first, so a new
 * event would shift every later page of a span that reached the present.
 */
const splitAtSettled = (span: Span, now: number): Span[] =>
  [
    { from: span.from, until: Math.min(span.until, now - SETTLE_MS) },
    { from: Math.max(span.from, now - SETTLE_MS + 1), until: span.until },
  ].filter((part) => part.from <= part.until);

/** Spans to read so `history` plus them covers `window`, keeping coverage contiguous. */
function missingSpans(history: AccountHistory | undefined, window: Span, now: number): Span[] {
  if (!history) return splitAtSettled(window, now);
  // Within the TTL the last read speaks for the present too, so a window that
  // ends now does not refetch its last few seconds on every scan.
  const trustedUntil =
    now < history.checkedAt + TTL_MS ? Math.max(history.until, now) : history.settledUntil;
  return [
    ...(window.from < history.from ? [{ from: window.from, until: history.from - 1 }] : []),
    ...(window.until > trustedUntil
      ? splitAtSettled({ from: trustedUntil + 1, until: window.until }, now)
      : []),
  ];
}

/** A read span is authoritative for its whole range, so it replaces rather than appends. */
function cover(
  history: AccountHistory | undefined,
  accountKey: string,
  span: Span,
  records: readonly UsageRecord[],
  now: number,
): AccountHistory {
  const base = history ?? {
    ...span,
    accountKey,
    settledUntil: span.from - 1,
    checkedAt: now,
    records: [],
  };
  return {
    accountKey,
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
    records: [
      ...base.records.filter(
        (record) => record.timestampMs < span.from || record.timestampMs > span.until,
      ),
      ...records,
    ],
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
    records: history.records.filter((record) => record.timestampMs >= floor),
  };
}

const credentialKey = (source: CursorCredentialSource) =>
  typeof source === "string" ? `file:${source}` : "keychain";

/**
 * Reads one Cursor login's account history for `[sinceMs, untilMs]`, serving
 * settled rows from memory. A login that now names a different account drops
 * what was kept for the old one.
 */
export function makeCursorAccountHistory(
  read: ReadAccount = readCursorAccountUsage,
  clock: () => number = Date.now,
) {
  const histories = new Map<string, AccountHistory>();
  // One read per login at a time, so a concurrent repeat is served from the
  // first read's coverage instead of racing it to the API.
  const turns = new Map<string, Promise<unknown>>();

  const readWindow = async (
    source: CursorCredentialSource,
    window: Span,
  ): Promise<CursorAccountUsageReadResult> => {
    const key = credentialKey(source);
    const now = clock();
    const readMissing = (history: AccountHistory | undefined) =>
      Promise.all(
        missingSpans(history, window, now).map(async (span) => ({
          span,
          result: await read(source, span.from, span.until),
        })),
      );
    let history = retain(histories.get(key), now);
    let reads = await readMissing(history);
    if (history && reads.some(({ result }) => result.accountKey !== history?.accountKey)) {
      history = undefined;
      reads = await readMissing(undefined);
    }
    const failed = reads.find(
      ({ result }) => result.error !== null || result.missing || result.accountKey === null,
    );
    if (failed) {
      if (history) histories.set(key, history);
      else histories.delete(key);
      return failed.result;
    }
    for (const { span, result } of reads) {
      history = cover(history, result.accountKey!, span, result.records, now);
    }
    if (!history) return { accountKey: null, records: [], missing: true, error: null };
    histories.set(key, history);
    return {
      accountKey: history.accountKey,
      records: history.records.filter(
        (record) => record.timestampMs >= window.from && record.timestampMs <= window.until,
      ),
      missing: false,
      error: null,
    };
  };

  return (
    source: CursorCredentialSource,
    sinceMs: number,
    untilMs: number,
  ): Promise<CursorAccountUsageReadResult> => {
    const key = credentialKey(source);
    const result = (turns.get(key) ?? Promise.resolve()).then(() =>
      readWindow(source, { from: sinceMs, until: untilMs }),
    );
    turns.set(
      key,
      result.catch(() => undefined),
    );
    return result;
  };
}
