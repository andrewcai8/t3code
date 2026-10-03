import type { RepositoryIdentity } from "./environment.ts";

/** The `owner/name` a cloud environment clones for this checkout: a fork's own remote, not its upstream. */
export function cloneRepository(
  identity: RepositoryIdentity | null | undefined,
): string | undefined {
  const source = identity?.origin ?? identity;
  return source?.owner && source.name ? `${source.owner}/${source.name}` : undefined;
}
