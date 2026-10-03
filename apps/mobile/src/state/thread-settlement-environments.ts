import type { EnvironmentId } from "@t3tools/contracts";

/**
 * The environments whose threads may settle: those advertising it, plus any thread's environment
 * with no loaded config (an offline cloud box with a cached shell). The command is checked
 * against the box's capabilities once it reconnects.
 */
export function threadSettlementEnvironmentIds(
  environments: {
    readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, unknown>;
  },
  threads: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
): ReadonlySet<EnvironmentId> {
  const configless = threads.filter(
    (thread) => !environments.machineByEnvironmentId.has(thread.environmentId),
  );
  if (configless.length === 0) return environments.settlementEnvironmentIds;
  const ids = new Set(environments.settlementEnvironmentIds);
  for (const thread of configless) ids.add(thread.environmentId);
  return ids;
}
