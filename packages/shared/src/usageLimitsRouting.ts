/**
 * Account routing for cloud chats and the shared-subscription check it pools
 * accounts by. `usageLimits` re-exports this module.
 *
 * @module usageLimitsRouting
 */
import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  type LimitPresentations,
  accountKey,
  providersWithLimits,
  remainingPercent,
  resetMillis,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Notices naming accounts whose limits read identically, as `collectLimitNotices` lists them. */
export function identicalReadingNotices(presentations: LimitPresentations): string[] {
  const readings = [...presentations].flatMap(([environmentId, presentation]) => [
    ...providersWithLimits(presentation.serverConfig?.providers ?? []).map((provider) =>
      providerReading(provider, `${environmentId}:${provider.instanceId}`),
    ),
    ...(presentation.serverConfig?.usageLimitSources ?? []).flatMap((source) =>
      source.accounts.map((account) => ({
        key:
          accountKey(account.driver, account.email, account.usageLimits) ??
          `${source.id}:${account.id}`,
        driver: account.driver,
        name: account.email ?? account.id,
        limits: account.usageLimits,
      })),
    ),
  ]);
  return findIdenticalReadings(readings).map(
    (names) => `${names.join(", ")} report identical limits, so they may be one account.`,
  );
}

interface LimitReading {
  readonly key: string;
  readonly driver: ServerProvider["driver"];
  readonly name: string;
  readonly limits: ServerProviderUsageLimits | undefined;
}

function providerReading(provider: ServerProvider, fallbackKey: string): LimitReading {
  return {
    key: accountKey(provider.driver, provider.auth.email, provider.usageLimits) ?? fallbackKey,
    driver: provider.driver,
    name: provider.displayName?.trim() || provider.auth.email || String(provider.instanceId),
    limits: provider.usageLimits,
  };
}

/**
 * Accounts whose readings agree window for window, share used and reset
 * alike. Separate subscriptions do not land on the same numbers, so a match
 * means logins filed under different accounts are one subscription, usually a
 * setup token made while signed in to another account. Only windows with a
 * reset are compared, as an idle window may have none, and a reading counts
 * only when one of those shows use, since untouched accounts all read 0%.
 * Each group names its suspects once for a person to check; rows never merge.
 * A group that names one account is that account seen before its email was.
 */
function findIdenticalReadings(readings: readonly LimitReading[]): string[][] {
  const bySignature = new Map<string, Map<string, LimitReading>>();
  for (const reading of readings) {
    const signature = readingSignature(reading.driver, reading.limits);
    if (signature === null) continue;
    const group = bySignature.get(signature) ?? new Map<string, LimitReading>();
    if (!group.has(reading.key)) group.set(reading.key, reading);
    bySignature.set(signature, group);
  }
  return [...bySignature.values()]
    .map((group) => [...new Set([...group.values()].map(({ name }) => name))])
    .filter((names) => names.length > 1);
}

/** What `findIdenticalReadings` compares, null for a reading that cannot tell accounts apart. */
function readingSignature(
  driver: ServerProvider["driver"],
  limits: ServerProviderUsageLimits | undefined,
): string | null {
  if (!limits || limits.unavailable) return null;
  const timed = limits.windows.flatMap((window) => {
    const at = resetMillis(window);
    return at === null ? [] : [{ window, at }];
  });
  if (timed.every(({ window }) => window.usedPercent === 0)) return null;
  return [
    driver,
    ...timed
      .map(({ window, at }) => `${window.kind}:${window.id}:${window.usedPercent}:${at}`)
      .sort(),
  ].join("|");
}

/** Older than this, a snapshot cannot say a window with no reset is still spent. */
const USAGE_LIMITS_STALE_MS = 30 * MINUTE;

/**
 * How far ahead routing looks for a new chat, whose length it cannot know.
 * An agent run lasts hours, and five hours is the shortest window any
 * provider resets on, so a session window always refills within it and a
 * weekly or monthly one days away never does.
 */
const ROUTING_HORIZON_MS = 5 * HOUR;

/**
 * How much an account has for a chat over `ROUTING_HORIZON_MS` before any of
 * its windows stops it, in percent of a full window: the tightest window's.
 * A window that refills within the horizon is full for the part of it left
 * after the reset, as far as its room lasts until then at the window's own
 * pace. So 5% left with a reset in ten minutes counts as nearly 100, 1% left
 * with a reset in half an hour as about 10, and 40% left with a reset in six
 * days as 40. A window spent right now
 * counts as 0 however soon it refills, since the chat's first turn would
 * fail. A window past its reset counts as full, and an account with no
 * subscription limits (an API key) as 100.
 * A window's usage only rises until it resets, so an old reading still
 * counts as the best the host knows. `null` means unknown: a failed probe,
 * no report at all, or an old reading of a spent window that never reports
 * when it resets and no other window still spent.
 * Ranking divides it among the account's active sessions plus the new one.
 */
export interface AccountHeadroom {
  readonly remainingPercent: number;
  /** When the tightest window refills, null when it never reports a reset. */
  readonly resetsAt: number | null;
}

/**
 * The windows that decide whether an account can take another turn.
 *
 * Cursor reports two pools and a combined figure. Cloud chats run Cursor's
 * default model, Auto, which draws on either pool, so the combined figure is
 * the account's remaining capacity. Ranking on the tighter pool would call an
 * account spent while its Auto turns still succeed (the API pool reads 100%
 * long before Auto stops). Without the combined figure, Auto keeps running
 * while either pool has room, so the roomier pool stands in for it.
 */
function headroomWindows(
  driver: ServerProvider["driver"],
  windows: readonly ServerProviderUsageWindow[],
  now: number,
): readonly ServerProviderUsageWindow[] {
  if (driver !== "cursor") return windows;
  const overall = windows.filter((window) => window.id === "totalPercentUsed");
  if (overall.length > 0) return overall;
  // A pool past its reset is full again, which leaves the account room.
  if (windows.some((window) => (resetMillis(window) ?? Infinity) <= now)) return [];
  const roomiest = windows.reduce<ServerProviderUsageWindow | undefined>(
    (best, window) =>
      best === undefined || remainingPercent(window) > remainingPercent(best) ? window : best,
    undefined,
  );
  return roomiest ? [roomiest] : [];
}

/**
 * The share of a window used at its own pace between now and its reset: what
 * the room left must cover for a chat to run until the window refills.
 */
const percentNeededUntil = (window: ServerProviderUsageWindow, resetsAt: number, now: number) =>
  (100 * (resetsAt - now)) /
  (window.windowDurationMins ? window.windowDurationMins * MINUTE : ROUTING_HORIZON_MS);

function accountHeadroom(
  driver: ServerProvider["driver"],
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): AccountHeadroom | null {
  if (!limits || limits.unavailable?.reason === "probeFailed") return null;
  if (limits.unavailable?.reason === "unsupported")
    return { remainingPercent: 100, resetsAt: null };
  const checkedAt = Date.parse(limits.checkedAt);
  if (!Number.isFinite(checkedAt)) return null;
  const stale = now - checkedAt > USAGE_LIMITS_STALE_MS;
  let tightest: AccountHeadroom = { remainingPercent: 100, resetsAt: null };
  let unvouched = false;
  for (const window of headroomWindows(driver, limits.windows, now)) {
    const resetsAt = resetMillis(window);
    if (resetsAt !== null && resetsAt <= now) continue;
    const remaining = remainingPercent(window);
    if (stale && resetsAt === null && remaining <= 0) {
      unvouched = true;
      continue;
    }
    const refilled =
      remaining <= 0 || resetsAt === null
        ? 0
        : Math.max(0, 1 - (resetsAt - now) / ROUTING_HORIZON_MS) *
          (100 - remaining) *
          Math.min(1, remaining / percentNeededUntil(window, resetsAt, now));
    const available = remaining + refilled;
    if (
      available < tightest.remainingPercent ||
      (available === tightest.remainingPercent && earlier(resetsAt, tightest.resetsAt))
    )
      tightest = { remainingPercent: available, resetsAt };
  }
  return unvouched && tightest.remainingPercent > 0 ? null : tightest;
}

/** Whether an account is known to have no usage left in some window that has not reset. */
export function isAccountSpent(
  driver: ServerProvider["driver"],
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean {
  return headroomTier(accountHeadroom(driver, limits, now)) === 2;
}

/** Known room first, then unknown, then known to be spent: a spent account fails its first turn. */
const headroomTier = (headroom: AccountHeadroom | null) =>
  headroom === null ? 1 : headroom.remainingPercent > 0 ? 0 : 2;

const earlier = (left: number | null, right: number | null) =>
  left !== null && (right === null || left < right);

/** Sessions already running on each account when a new chat is routed; absent means none. */
export type AccountLoad = ReadonlyMap<ProviderInstanceId, number>;

/**
 * Accounts of one driver, the one whose remaining usage leaves the new chat
 * the largest share first: `remainingPercent / (active + 1)`. Not knowing how
 * much a chat will use, routing gives it the account where its fair share of
 * what is left is largest, which spreads chats out. Instances of one
 * subscription, by email, credential, or identical readings, count the
 * sessions of all. Unknown
 * headroom ranks below any account with room left, fewest active sessions
 * first, and above a spent one. Ties go to the account whose tightest window
 * refills first, then the preferred account, then the id, so the same
 * snapshots always rank the same way.
 */
export function rankAccounts<
  A extends {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ServerProvider["driver"];
    readonly email?: string | undefined;
    readonly usageLimits?: ServerProviderUsageLimits | undefined;
  },
>(accounts: readonly A[], now: number, preferred?: ProviderInstanceId, load?: AccountLoad): A[] {
  // One subscription is one pool, whichever key names it: an email, a
  // credential, or readings that match window for window.
  const parent = new Map<string, string>();
  const root = (key: string): string => {
    const up = parent.get(key) ?? key;
    return up === key ? key : root(up);
  };
  const keysOf = (account: A) =>
    [
      accountKey(account.driver, account.email, account.usageLimits) ?? account.instanceId,
      readingSignature(account.driver, account.usageLimits),
    ].filter((key) => key !== null);
  for (const account of accounts) {
    const [first, ...rest] = keysOf(account).map(root);
    for (const key of rest) if (key !== first) parent.set(key, first!);
  }
  const keyOf = (account: A) => root(keysOf(account)[0]!);
  const sessions = new Map<string, number>();
  for (const account of accounts)
    sessions.set(
      keyOf(account),
      (sessions.get(keyOf(account)) ?? 0) + (load?.get(account.instanceId) ?? 0),
    );
  const scored = accounts.map((account) => ({
    account,
    headroom: accountHeadroom(account.driver, account.usageLimits, now),
    active: sessions.get(keyOf(account)) ?? 0,
  }));
  return scored
    .sort((left, right) => {
      const a = left.headroom;
      const b = right.headroom;
      const tierDelta = headroomTier(a) - headroomTier(b);
      if (tierDelta !== 0) return tierDelta;
      if (a !== null && b !== null) {
        const shareDelta =
          b.remainingPercent / (right.active + 1) - a.remainingPercent / (left.active + 1);
        if (shareDelta !== 0) return shareDelta;
        if (a.resetsAt !== b.resetsAt) return earlier(a.resetsAt, b.resetsAt) ? -1 : 1;
      } else if (left.active !== right.active) return left.active - right.active;
      if (left.account.instanceId === preferred) return -1;
      if (right.account.instanceId === preferred) return 1;
      return left.account.instanceId < right.account.instanceId ? -1 : 1;
    })
    .map(({ account }) => account);
}
