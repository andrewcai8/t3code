/**
 * The server a pairing URL pairs with: its origin plus any path before `/pair`, so a host's
 * gateway path to a provisioned environment survives.
 */
export function pairingUrlHost(url: URL): string {
  const host = new URL(url.origin);
  host.pathname = url.pathname.replace(/\/pair\/?$/u, "/") || "/";
  return host.toString();
}
