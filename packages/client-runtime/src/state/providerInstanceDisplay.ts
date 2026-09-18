/**
 * How a configured provider instance presents itself in a client: its label,
 * its accent color, and whether its icon carries the account badge. Shared by
 * web and mobile so both clients name and badge the same instance identically.
 *
 * @module providerInstanceDisplay
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/shared/providerInstanceDisplay";

export { resolveProviderInstanceDisplayName };

/**
 * Turn a display name into up to two initials for the badge: the first two
 * characters of a single word, or the first character of each of the first
 * two words. Iterates by code point so an emoji never splits into surrogates.
 */
export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

/** Only `#rrggbb` accent colors render; anything else is treated as unset. */
export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * several instances sharing a driver so the brand glyph alone is ambiguous.
 * Shared by the composer trigger, the picker rail, and sidebar/thread rows.
 */
export function shouldShowInstanceBadge(
  entry: { readonly driverKind: ProviderDriverKind; readonly accentColor?: string | undefined },
  entries: Iterable<{ readonly driverKind: ProviderDriverKind }>,
): boolean {
  if (entry.accentColor) return true;
  let sharedDriverCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind === entry.driverKind && ++sharedDriverCount > 1) return true;
  }
  return false;
}
