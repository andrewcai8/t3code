import { buildHostedPairingUrl } from "../../hostedPairing";
import { isLoopbackHostname } from "../../environments/primary/target";
import { setPairingTokenOnUrl } from "../../pairingUrl";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

/** False for a loopback pairing URL: another device scanning it would dial itself, not the machine that minted it. */
export function isOffDeviceReachablePairingUrl(pairingUrl: string): boolean {
  try {
    return !isLoopbackHostname(new URL(pairingUrl).hostname);
  } catch {
    return false;
  }
}
