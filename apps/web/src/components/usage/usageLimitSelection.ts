import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";

/**
 * Limits come only from environments that are connected right now, the same rule the page's
 * refresh uses. A disconnected environment (a paused cloud machine, say) keeps its last cached
 * config, whose windows are hours old: they show outdated numbers and add account columns that
 * never merge with live readings.
 */
export function selectLimitPresentations(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentationWithProviders>,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenDrivers: ReadonlySet<ServerProvider["driver"]>,
): Map<EnvironmentId, EnvironmentPresentationWithProviders> {
  const isVisible = (driver: ServerProvider["driver"]) => !hiddenDrivers.has(driver);
  return new Map(
    [...presentations].flatMap(([id, presentation]) => {
      if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(id)) return [];
      const config = presentation.serverConfig;
      if (presentation.connection.phase !== "connected" || config === null) return [];
      if (hiddenDrivers.size === 0) return [[id, presentation] as const];
      return [
        [
          id,
          {
            ...presentation,
            serverConfig: {
              ...config,
              providers: config.providers.filter((provider) => isVisible(provider.driver)),
              usageLimitSources: config.usageLimitSources?.flatMap((source) => {
                const accounts = source.accounts.filter((account) => isVisible(account.driver));
                return accounts.length === 0 && source.accounts.length > 0
                  ? []
                  : [{ ...source, accounts }];
              }),
            },
          },
        ] as const,
      ];
    }),
  );
}
