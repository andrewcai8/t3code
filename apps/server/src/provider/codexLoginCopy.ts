/**
 * Codex rotates a ChatGPT login's refresh token on every refresh and rejects
 * reuse, so when copies of one `auth.json` exist, whichever refreshes first
 * logs out every other copy. The user's own machine is the only copy that
 * refreshes. A copy for a manager or a cloud environment keeps the access
 * token and gets a refresh token that can never be redeemed, so it works
 * until that access token expires.
 *
 * Codex still loads the file (`refresh_token` is a required string), and a
 * refresh attempt fails with a 401 that Codex records as permanent. An empty
 * string would instead get a 400 that Codex treats as transient and retries
 * on every request.
 */
const UNREDEEMABLE_CODEX_REFRESH_TOKEN = "t3-copy-cannot-refresh";

/** A run started on a login this close to expiry would lose it partway through. */
const CODEX_LOGIN_MIN_LIFETIME_MS = 30 * 60 * 1000;

/** Text Codex could not load, or a login without a refresh token, is returned unchanged. */
export function stripCodexRefreshToken(authJson: string): string {
  const auth = parseJson(authJson);
  if (!isRecord(auth) || !isRecord(auth.tokens) || typeof auth.tokens.refresh_token !== "string")
    return authJson;
  return JSON.stringify(
    { ...auth, tokens: { ...auth.tokens, refresh_token: UNREDEEMABLE_CODEX_REFRESH_TOKEN } },
    null,
    2,
  );
}

export interface CodexLogin {
  /** Epoch milliseconds from the access token's `exp`; absent when it cannot be read. */
  readonly accessTokenExpiresAt?: number;
  /** False for a copy made by `stripCodexRefreshToken`. */
  readonly refreshable: boolean;
}

export function parseCodexLogin(authJson: string): CodexLogin {
  const auth = parseJson(authJson);
  const tokens = isRecord(auth) && isRecord(auth.tokens) ? auth.tokens : undefined;
  const refreshable = tokens?.refresh_token !== UNREDEEMABLE_CODEX_REFRESH_TOKEN;
  const payload =
    typeof tokens?.access_token === "string"
      ? parseJson(base64UrlDecode(tokens.access_token.split(".")[1] ?? ""))
      : undefined;
  return isRecord(payload) && typeof payload.exp === "number" && Number.isFinite(payload.exp)
    ? { accessTokenExpiresAt: payload.exp * 1000, refreshable }
    : { refreshable };
}

/** An unknown expiry counts as usable: Codex decides then, not this guess. */
export const codexLoginExpiring = (login: CodexLogin, now: number) =>
  login.accessTokenExpiresAt !== undefined &&
  login.accessTokenExpiresAt - now < CODEX_LOGIN_MIN_LIFETIME_MS;

export const codexLoginExpiredMessage = (account: string) =>
  `${account}'s Codex login expired; sign in on your computer and reseed.`;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const base64UrlDecode = (segment: string) => Buffer.from(segment, "base64url").toString("utf8");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
