import type { RepositoryIdentity } from "./environment.ts";

/** The `owner/name` a cloud environment clones for this checkout: a fork's own remote, not its upstream. */
export function cloneRepository(
  identity: RepositoryIdentity | null | undefined,
): string | undefined {
  if (identity?.origin) {
    const segments = identity.origin.canonicalKey
      .split("/")
      .slice(1)
      .filter((segment) => segment.length > 0);
    const owner = segments[0];
    const name = segments.at(-1);
    return owner && name ? `${owner}/${name}` : undefined;
  }
  return identity?.owner && identity.name ? `${identity.owner}/${identity.name}` : undefined;
}
