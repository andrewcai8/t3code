/**
 * Settlement is allowed when the server advertised the command, and also
 * when no config is loaded yet (a disconnected environment with a cached
 * shell). Old servers that decoded without the capability stay on the
 * previous fallback: the client must not send `thread.settle`.
 */
export function environmentAllowsThreadSettlement(
  capabilities: { readonly threadSettlement?: boolean } | undefined,
): boolean {
  return capabilities === undefined || capabilities.threadSettlement === true;
}

/** Environments whose threads may classify into the settled shelf. */
export function collectSettlementEnvironmentIds<TEnvironmentId>(
  configs: ReadonlyMap<
    TEnvironmentId,
    { readonly environment: { readonly capabilities: { readonly threadSettlement?: boolean } } }
  >,
  extraEnvironmentIds: Iterable<TEnvironmentId> = [],
): Set<TEnvironmentId> {
  const supported = new Set<TEnvironmentId>();
  for (const [environmentId, config] of configs) {
    if (environmentAllowsThreadSettlement(config.environment.capabilities)) {
      supported.add(environmentId);
    }
  }
  for (const environmentId of extraEnvironmentIds) {
    if (environmentAllowsThreadSettlement(configs.get(environmentId)?.environment.capabilities)) {
      supported.add(environmentId);
    }
  }
  return supported;
}
