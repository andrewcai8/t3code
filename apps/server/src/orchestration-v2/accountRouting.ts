import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  type AccountLoad,
  rankAccounts,
  ROUTED_ACCOUNT_DRIVERS,
} from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { readLocalAccountLoad } from "../environmentControl/accountLoad.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";

export interface AccountRequest {
  readonly projectId: ProjectId;
  readonly selection: ModelSelection;
  /** The thread's account; a selection of the same driver keeps it rather than routing again. */
  readonly current?: ProviderInstanceId | undefined;
}

/**
 * The selection a chat runs with when this host picks the account. Only a driver whose accounts
 * are interchangeable is routed, among its accounts enabled for the project, not signed out, and
 * serving the selected model, by the cloud manager's ranking (`rankAccounts`) with the selected
 * account winning ties. A thread keeps its account: pickers offer the driver rather than each
 * account while routing is on, so a follow-up naming another account of the driver is that
 * driver's row, not a request to move.
 */
export function routeSelection(
  input: AccountRequest & {
    readonly settings: ServerSettings;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly load?: AccountLoad;
  },
): ModelSelection {
  const { selection, providers } = input;
  if (!input.settings.autoPickProviderAccounts) return selection;
  const driverOf = (instanceId: ProviderInstanceId | undefined) =>
    providers.find((provider) => provider.instanceId === instanceId)?.driver;
  const driver = driverOf(selection.instanceId);
  if (driver === undefined || !ROUTED_ACCOUNT_DRIVERS.has(driver)) return selection;
  const pick = (instanceId: ProviderInstanceId) =>
    instanceId === selection.instanceId ? selection : { ...selection, instanceId };
  if (input.current !== undefined && driverOf(input.current) === driver) return pick(input.current);
  const accounts = providers.filter(
    (provider) =>
      provider.driver === driver &&
      provider.enabled &&
      isProviderAvailable(provider) &&
      provider.auth.status !== "unauthenticated" &&
      resolveProjectProviderInstanceEnabled(input.settings, input.projectId, provider.instanceId) &&
      (provider.models.length === 0 ||
        provider.models.some((model) => model.slug === selection.model)),
  );
  const [best] = rankAccounts(
    accounts.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      email: provider.auth.email,
      usageLimits: provider.usageLimits,
    })),
    input.now,
    selection.instanceId,
    input.load,
  );
  return best === undefined ? selection : pick(best.instanceId);
}

/**
 * Routes a chat's selection with this host's settings, provider readings and running sessions.
 * Without a provider registry, as in narrow test layers, selections pass through unchanged.
 */
export const makeAccountRouting = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const settings = yield* Effect.serviceOption(ServerSettingsService.ServerSettingsService);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  return Effect.fn("accountRouting.route")(function* (request: AccountRequest) {
    if (Option.isNone(registry) || Option.isNone(settings)) return request.selection;
    const current = yield* settings.value.getSettings.pipe(Effect.option);
    if (Option.isNone(current) || !current.value.autoPickProviderAccounts) return request.selection;
    return routeSelection({
      ...request,
      settings: current.value,
      providers: yield* registry.value.getProviders,
      now: yield* Clock.currentTimeMillis,
      ...(Option.isSome(sql) ? { load: yield* readLocalAccountLoad(sql.value) } : {}),
    });
  });
});
