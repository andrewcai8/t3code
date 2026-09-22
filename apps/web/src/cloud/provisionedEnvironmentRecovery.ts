import type { EnvironmentId, EnvironmentProvisionResumeResult } from "@t3tools/contracts";

export type ProvisionedEnvironmentRecovery =
  | { readonly kind: "ready" }
  | { readonly kind: "not-provisioned" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Wakes a paused cloud workspace through whichever connected manager provisioned it.
 * `not-provisioned` means no connected manager knows the environment, so the caller
 * falls back to an ordinary connection retry.
 */
export function createProvisionedEnvironmentRecovery(operations: {
  managers: (environmentId: EnvironmentId) => ReadonlyArray<EnvironmentId>;
  /** Null when the manager could not answer. */
  resume: (
    managerId: EnvironmentId,
    environmentId: EnvironmentId,
  ) => Promise<EnvironmentProvisionResumeResult | null>;
  markMissing: (environmentId: EnvironmentId) => Promise<void>;
  retry: (environmentId: EnvironmentId) => Promise<void>;
  awaitConnected: (environmentId: EnvironmentId) => Promise<void>;
}) {
  const pending = new Map<EnvironmentId, Promise<ProvisionedEnvironmentRecovery>>();
  return (environmentId: EnvironmentId): Promise<ProvisionedEnvironmentRecovery> => {
    const existing = pending.get(environmentId);
    if (existing) return existing;
    const recovery = (async (): Promise<ProvisionedEnvironmentRecovery> => {
      const results = await Promise.all(
        operations
          .managers(environmentId)
          .map((managerId) => operations.resume(managerId, environmentId)),
      );
      if (!results.some((result) => result?.kind === "resumed")) {
        const refusal = results.find(
          (result) => result?.kind === "refused" && result.reason !== "not-provisioned",
        );
        if (refusal?.kind !== "refused") return { kind: "not-provisioned" };
        if (refusal.reason === "missing") await operations.markMissing(environmentId);
        throw new Error(refusal.message);
      }
      await operations.retry(environmentId);
      await operations.awaitConnected(environmentId);
      return { kind: "ready" };
    })()
      .catch((cause): ProvisionedEnvironmentRecovery => ({
        kind: "failed",
        message: cause instanceof Error ? cause.message : "The workspace could not be reconnected.",
      }))
      .finally(() => pending.delete(environmentId));
    pending.set(environmentId, recovery);
    return recovery;
  };
}
