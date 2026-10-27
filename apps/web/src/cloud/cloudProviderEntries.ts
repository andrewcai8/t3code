import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { ROUTED_ACCOUNT_DRIVERS } from "@t3tools/shared/usageLimits";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../providerInstances";

const usable = (entry: ProviderInstanceEntry) =>
  entry.isAvailable &&
  entry.status !== "disabled" &&
  entry.snapshot.auth.status !== "unauthenticated";

/**
 * One account per routed driver to stand for it in a picker: a usable account first, then a
 * ready one, then `preferred`, then the driver's default.
 */
function driverAccounts(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  preferred?: ProviderInstanceId,
): Map<ProviderDriverKind, ProviderInstanceEntry> {
  const rank = (entry: ProviderInstanceEntry) =>
    (usable(entry) ? 8 : 0) +
    (isProviderInstancePickerReady(entry) ? 4 : 0) +
    (entry.instanceId === preferred ? 2 : 0) +
    (entry.isDefault ? 1 : 0);
  const byDriver = new Map<ProviderDriverKind, ProviderInstanceEntry>();
  for (const entry of entries) {
    if (!ROUTED_ACCOUNT_DRIVERS.has(entry.driverKind) || !isProviderInstancePickerVisible(entry)) {
      continue;
    }
    const current = byDriver.get(entry.driverKind);
    if (!current || rank(entry) > rank(current)) byDriver.set(entry.driverKind, entry);
  }
  return byDriver;
}

const asDriver = (entry: ProviderInstanceEntry): ProviderInstanceEntry => ({
  ...entry,
  displayName: PROVIDER_DISPLAY_NAMES[entry.driverKind] ?? entry.displayName,
  accentColor: undefined,
});

/**
 * The picker rail for a draft that starts a cloud environment: one entry per cloud-capable driver,
 * labeled as the driver because the manager routes to the account with the most usage left. The entry
 * is a real local instance so its id rides along as the provision hint, with the hint's own models.
 * Ready whenever the hint is not known signed out: the box, not this host, runs the agent.
 */
export function cloudProviderEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  return [...driverAccounts(entries).values()].map((entry) => ({
    ...asDriver(entry),
    status: usable(entry) ? "ready" : entry.status,
  }));
}

/**
 * The picker rail of an environment that picks each chat's account itself
 * (`autoPickProviderAccounts`): each routed driver once, in place of its accounts. The selected
 * account stands for its driver when usable, so a thread shows the account it runs on.
 */
export function accountPickedProviderEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  selectedInstanceId: ProviderInstanceId,
): ReadonlyArray<ProviderInstanceEntry> {
  const accounts = driverAccounts(entries, selectedInstanceId);
  const shown = new Set<ProviderDriverKind>();
  return entries.flatMap((entry) => {
    const account = accounts.get(entry.driverKind);
    if (account === undefined) return [entry];
    if (shown.has(entry.driverKind)) return [];
    shown.add(entry.driverKind);
    return [asDriver(account)];
  });
}

/**
 * The model picker's rail and selection for a composer: the cloud drivers while its draft will
 * start a cloud environment, or each driver once while its environment picks accounts, where a
 * draft still pinned to another account of a driver shows as that driver's row; otherwise the
 * composer's own instances.
 */
export function cloudProviderPicker(input: {
  readonly startsCloudEnvironment: boolean;
  readonly autoPickAccounts: boolean;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selectedProvider: ProviderDriverKind;
  readonly selectedInstanceId: ProviderInstanceId;
}) {
  const { entries, selectedProvider, selectedInstanceId } = input;
  const instanceEntries = input.startsCloudEnvironment
    ? cloudProviderEntries(entries)
    : input.autoPickAccounts
      ? accountPickedProviderEntries(entries, selectedInstanceId)
      : entries;
  const activeInstanceId =
    (input.startsCloudEnvironment || input.autoPickAccounts
      ? instanceEntries.find((entry) => entry.driverKind === selectedProvider)?.instanceId
      : undefined) ?? selectedInstanceId;
  return { instanceEntries, activeInstanceId };
}
