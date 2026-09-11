/**
 * Whether a thread whose provider session died should be brought back.
 *
 * T3 already continues threads after a server update, with the prompt
 * "Continue where you left off." A session that dies while the server keeps
 * running gets no such treatment: it is settled with an error telling a human
 * to send a new message. That human is the bottleneck this decides to remove.
 *
 * The policy lives here as a pure function so it can be argued with and tested
 * without an Effect runtime, and so the reactor that owns the transition does
 * not also own the judgement about what to do with it.
 */

/** Why a revival was or was not attempted. Every answer carries its reason. */
export type RevivalDecision =
  | { readonly kind: "revive"; readonly attempt: number; readonly delayMs: number }
  | { readonly kind: "ignore"; readonly reason: IgnoreReason }
  | { readonly kind: "exhausted"; readonly attempts: number };

export type IgnoreReason =
  | "session-healthy"
  | "stopped-deliberately"
  | "thread-settled"
  | "no-work-lost";

export interface RevivalInput {
  /** Status the session landed in. `error` is a death; `stopped` is a choice. */
  readonly status: string;
  /** Failure detail recorded with the transition, if any. */
  readonly lastError: string | null;
  /** A settled thread has no work to return to. */
  readonly settled: boolean;
  /** True when this thread's stop was asked for rather than suffered. */
  readonly stopRequested: boolean;
  /** Revivals already attempted for this thread since it last made progress. */
  readonly attempts: number;
}

export const MAX_REVIVAL_ATTEMPTS = 3;

/**
 * Backoff between attempts.
 *
 * A session that dies on startup dies again immediately, and retrying in a
 * tight loop turns one broken thread into a burning account quota. Growing the
 * gap also leaves room for the cause to clear on its own, which is what a
 * paused host or an exhausted rate limit does.
 */
export const revivalDelayMs = (attempt: number) => Math.min(30_000, 2_000 * 2 ** (attempt - 1));

export function decideRevival(input: RevivalInput): RevivalDecision {
  // Only a death qualifies. `stopped` is what the code records when the stop
  // was intended, and reviving those would fight the person who asked.
  if (input.status !== "error") return { kind: "ignore", reason: "session-healthy" };
  if (input.stopRequested) return { kind: "ignore", reason: "stopped-deliberately" };
  if (input.settled) return { kind: "ignore", reason: "thread-settled" };
  // A death with no recorded cause is indistinguishable from an ordinary end.
  // Reviving on it would restart threads that simply finished.
  if (!input.lastError) return { kind: "ignore", reason: "no-work-lost" };
  if (input.attempts >= MAX_REVIVAL_ATTEMPTS)
    return { kind: "exhausted", attempts: input.attempts };
  const attempt = input.attempts + 1;
  return { kind: "revive", attempt, delayMs: revivalDelayMs(attempt) };
}
