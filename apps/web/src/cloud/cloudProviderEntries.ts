import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useMemo } from "react";

import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../providerInstances";

/** Drivers a provisioned cloud environment can run; mirrors the server's `credentialVariables`. */
const CLOUD_AGENT_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "cursor"]);

/**
 * The picker rail for a draft that starts a cloud environment: one entry per
 * cloud-capable driver, labeled as the driver rather than an account, because
 * the manager routes the provision to whichever account of that driver has the
 * most usage left. The entry is a real local instance so its id can ride along
 * as the provision hint: a usable account first, then a ready one, then the
 * driver's default. Its models are the hint's own; every account of a driver
 * serves the same catalog, and a union would offer models the hint cannot fall
 * back to.
 *
 * The row is ready whenever the hint is usable, meaning not known to be signed
 * out. The box runs the agent, not this host, so a host probe that timed out
 * says nothing about the chat, and the manager refuses with the reason when no
 * account's login can be copied.
 */
export function cloudProviderEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  const byDriver = new Map<ProviderDriverKind, ProviderInstanceEntry>();
  const usable = (entry: ProviderInstanceEntry) =>
    entry.isAvailable &&
    entry.status !== "disabled" &&
    entry.snapshot.auth.status !== "unauthenticated";
  const rank = (entry: ProviderInstanceEntry) =>
    (usable(entry) ? 4 : 0) +
    (isProviderInstancePickerReady(entry) ? 2 : 0) +
    (entry.isDefault ? 1 : 0);
  for (const entry of entries) {
    if (!CLOUD_AGENT_DRIVERS.has(entry.driverKind) || !isProviderInstancePickerVisible(entry)) {
      continue;
    }
    const current = byDriver.get(entry.driverKind);
    if (!current || rank(entry) > rank(current)) byDriver.set(entry.driverKind, entry);
  }
  return [...byDriver.values()].map((entry) => ({
    ...entry,
    displayName: PROVIDER_DISPLAY_NAMES[entry.driverKind] ?? entry.displayName,
    accentColor: undefined,
    status: usable(entry) ? "ready" : entry.status,
  }));
}

/**
 * The model picker's rail and selection for a composer: the cloud drivers while its draft will
 * start a cloud environment, where a draft still pinned to another account of a driver shows as
 * that driver's row; otherwise the composer's own instances.
 */
export function useCloudProviderPicker(input: {
  readonly startsCloudEnvironment: boolean;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId: ProviderInstanceId;
}) {
  const { startsCloudEnvironment, entries, selectedProvider, selectedInstanceId } = input;
  const instanceEntries = useMemo(
    () => (startsCloudEnvironment ? cloudProviderEntries(entries) : entries),
    [entries, startsCloudEnvironment],
  );
  const activeInstanceId =
    (startsCloudEnvironment
      ? instanceEntries.find((entry) => entry.driverKind === selectedProvider)?.instanceId
      : undefined) ?? selectedInstanceId;
  return { instanceEntries, activeInstanceId };
}
