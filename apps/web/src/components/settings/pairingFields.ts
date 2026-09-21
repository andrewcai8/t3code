import { readHostedPairingRequest } from "../../hostedPairing";
import { getPairingTokenFromUrl } from "../../pairingUrl";

export function parsePairingUrlFields(
  input: string,
): { readonly host: string; readonly pairingCode: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(
      urlLikeInput,
      typeof window === "undefined" ? undefined : window.location.origin,
    );
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      return {
        host: hostedPairingRequest.host,
        pairingCode: hostedPairingRequest.token,
      };
    }

    const pairingCode = getPairingTokenFromUrl(url);
    if (!pairingCode) return null;
    const host = new URL(url.origin);
    host.pathname = url.pathname.replace(/\/pair\/?$/u, "/") || "/";
    return {
      host: host.toString(),
      pairingCode,
    };
  } catch {
    return null;
  }
}
