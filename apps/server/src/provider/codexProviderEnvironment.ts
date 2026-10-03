import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

/**
 * A Codex instance's process environment. An ambient CODEX_HOME from the
 * shell that launched the server must not leak into an instance, so each
 * runs in its configured home, then its own CODEX_HOME, then the shared home.
 */
export function resolveCodexProviderEnvironment(
  instanceEnvironment: Parameters<typeof mergeProviderInstanceEnvironment>[0],
  ambientEnvironment: NodeJS.ProcessEnv,
  homeLayout: { readonly effectiveHomePath: string | undefined; readonly sharedHomePath: string },
): NodeJS.ProcessEnv {
  const { CODEX_HOME: _ambientHome, ...ambient } = ambientEnvironment;
  const environment = mergeProviderInstanceEnvironment(instanceEnvironment, ambient);
  return {
    ...environment,
    CODEX_HOME: homeLayout.effectiveHomePath ?? environment.CODEX_HOME ?? homeLayout.sharedHomePath,
  };
}

/**
 * How long a Codex status check waits on `codex app-server`. Longer than other
 * providers' auth probes: with CODEX_HOME on a network filesystem (EFS),
 * app-server startup opens its SQLite state there and can take 5-10 s before
 * it answers `initialize`.
 */
export const CODEX_APP_SERVER_PROBE_TIMEOUT_MS = 30_000;
