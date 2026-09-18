/**
 * The name a configured provider instance goes by. Clients label the picker
 * with it and the server names instances in errors with it, so a person reads
 * the same word in both places.
 *
 * @module providerInstanceDisplay
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * Title-case a slug: splits on `_` / `-` and camelCase boundaries, so
 * `codex_personal` becomes "Codex Personal" and `myCustomInstance` becomes
 * "My Custom Instance".
 */
export function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolve an instance's label with a tiered priority:
 *
 *   1. A `displayName` that differs from the driver's brand label — the
 *      instance has been explicitly named, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the name fell
 *      back to the driver-level label (the same for every instance of that
 *      kind), so the slug is what keeps "Codex" and "Codex Personal" apart.
 *   3. The `displayName`, or the brand label from contracts.
 */
export function resolveProviderInstanceDisplayName(instance: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName?: string | undefined;
}): string {
  const trimmedName = instance.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[instance.driver] ?? humanizeSlug(instance.driver);
  if (trimmedName && trimmedName !== kindLabel) return trimmedName;
  if (instance.instanceId !== defaultInstanceIdForDriver(instance.driver)) {
    const humanized = humanizeSlug(instance.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedName || kindLabel;
}
