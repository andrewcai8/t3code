/**
 * Resolve a server-relative URL (`/api/assets/...`) inside the environment's base, keeping any
 * path prefix such as a manager gateway's `/api/provisioned-environment/<leaseId>/`.
 */
export function environmentUrl(httpBaseUrl: string, relativeUrl: string): string {
  const base = new URL(httpBaseUrl);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  base.search = "";
  base.hash = "";
  return new URL(relativeUrl.replace(/^\/(?!\/)/, ""), base).toString();
}
