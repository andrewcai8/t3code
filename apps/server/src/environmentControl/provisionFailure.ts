/** Provider failures must reach the operator. Credentials in git/auth output must not. */
const SECRET =
  /AUTHORIZATION:\s*basic\s+\S+|x-access-token:[^@\s]+|ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|nsc_[A-Za-z0-9]+/gi;

export function provisionFailureMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (raw.length === 0) return fallback;
  const redacted = raw.replace(SECRET, "<redacted>");
  return redacted.length > 800 ? `${redacted.slice(0, 800)}…` : redacted;
}
