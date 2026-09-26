/**
 * Codex rotates a ChatGPT login's refresh token on every refresh and rejects
 * reuse, so when copies of one `auth.json` exist, whichever refreshes first
 * logs out every other copy. The user's own machine is the only copy that
 * refreshes. A copy for a manager or a cloud environment keeps the access
 * token and gets a refresh token that can never be redeemed.
 *
 * Codex still loads the file (`refresh_token` is a required string), and a
 * refresh attempt fails with a 401 that Codex records as permanent. An empty
 * string would instead get a 400 that Codex treats as transient and retries
 * on every request.
 */
const UNREDEEMABLE_CODEX_REFRESH_TOKEN = "t3-copy-cannot-refresh";

/** Text Codex could not load, or a login without a refresh token, is returned unchanged. */
export function stripCodexRefreshToken(authJson: string): string {
  let auth: unknown;
  try {
    auth = JSON.parse(authJson);
  } catch {
    return authJson;
  }
  if (!isRecord(auth) || !isRecord(auth.tokens) || typeof auth.tokens.refresh_token !== "string")
    return authJson;
  return JSON.stringify(
    { ...auth, tokens: { ...auth.tokens, refresh_token: UNREDEEMABLE_CODEX_REFRESH_TOKEN } },
    null,
    2,
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
