import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

/**
 * The checkout's own `origin`, when the identity came from another remote
 * (a fork's upstream). A fork's commits only exist on its own remote, so
 * anything cloning this checkout has to be told about that one too.
 */
export function repositoryOrigin(
  remotes: ReadonlyMap<string, string>,
  primaryRemoteName: string,
): { readonly owner: string; readonly name: string; readonly remoteUrl: string } | undefined {
  const remoteUrl = primaryRemoteName === "origin" ? undefined : remotes.get("origin");
  if (remoteUrl === undefined) return undefined;
  const segments = normalizeGitRemoteUrl(remoteUrl)
    .split("/")
    .slice(1)
    .filter((segment) => segment.length > 0);
  const owner = segments[0];
  const name = segments.at(-1);
  return owner && name ? { owner, name, remoteUrl } : undefined;
}
