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
