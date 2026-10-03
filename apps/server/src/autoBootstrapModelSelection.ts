import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";

import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";

/**
 * The bootstrap thread's model. A provisioned cloud box enables exactly one
 * driver and disables the rest, so `fallback` (the `codex` instance) would
 * point a fresh box at a provider it just disabled. Codex wins when it is
 * enabled, which is every local install, then whichever instance is.
 */
export const autoBootstrapModelSelection = (
  settings: ServerSettings,
  fallback: ModelSelection,
): ModelSelection => {
  const instances = deriveProviderInstanceConfigMap(settings);
  const codexInstance = instances[fallback.instanceId];
  if (codexInstance !== undefined && resolveProviderInstanceEnabled(codexInstance)) return fallback;
  const chosen = Object.entries(instances).find(([, instance]) =>
    resolveProviderInstanceEnabled(instance),
  );
  if (chosen === undefined) return fallback;
  const [instanceId, instance] = chosen;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    model: DEFAULT_MODEL_BY_PROVIDER[instance.driver] ?? fallback.model,
  };
};
