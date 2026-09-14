import type { EnvironmentId } from "@t3tools/contracts";
import { provisionedSandboxForEnvironment } from "./provisionedSandboxLeases";

export type ProvisionedEnvironmentRecovery =
  | { readonly kind: "ready" }
  | { readonly kind: "not-provisioned" }
  | { readonly kind: "failed"; readonly message: string };

export function createProvisionedEnvironmentRecovery(operations: {
  resume: (
    owned: NonNullable<ReturnType<typeof provisionedSandboxForEnvironment>>,
  ) => Promise<void>;
  retry: (environmentId: EnvironmentId) => Promise<void>;
  awaitConnected: (environmentId: EnvironmentId) => Promise<void>;
}) {
  const pending = new Map<EnvironmentId, Promise<ProvisionedEnvironmentRecovery>>();
  return (environmentId: EnvironmentId): Promise<ProvisionedEnvironmentRecovery> => {
    const existing = pending.get(environmentId);
    if (existing) return existing;
    const owned = provisionedSandboxForEnvironment(environmentId);
    if (!owned) return Promise.resolve({ kind: "not-provisioned" });
    const recovery = (async (): Promise<ProvisionedEnvironmentRecovery> => {
      await operations.resume(owned);
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
