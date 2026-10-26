import {
  isProviderAvailable,
  type ModelSelection,
  type ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  type AccountLoad,
  accountKey,
  hasKnownRoom,
  isAccountSpent,
  rankAccounts,
  ROUTED_ACCOUNT_DRIVERS,
} from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { readLocalAccountLoad } from "../environmentControl/accountLoad.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";

export interface AccountRequest {
  readonly projectId: ProjectId;
  readonly selection: ModelSelection;
  /** The thread's account; a selection of the same driver keeps it while it has usage left. */
  readonly current?: ProviderInstanceId | undefined;
}

/**
 * The selection a chat runs with when this host picks the account. Only a driver whose accounts are
 * interchangeable is routed, by the cloud manager's ranking (`rankAccounts`) with the selected
 * account winning ties. A thread keeps its account unless that account is known to be spent (by its
 * readings or, until the reset, `spentUntil`), and then only moves to one known to have room.
 */
export function routeSelection(
  input: AccountRequest & {
    readonly settings: ServerSettings;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly load?: AccountLoad;
    readonly spentUntil?: SpentAccounts;
  },
): ModelSelection {
  const { selection } = input;
  if (!input.settings.autoPickProviderAccounts) return selection;
  const providers = withUsageLimitFailures(input.providers, input.spentUntil, input.now);
  const driverOf = (instanceId: ProviderInstanceId | undefined) =>
    providers.find((provider) => provider.instanceId === instanceId)?.driver;
  const driver = driverOf(selection.instanceId);
  if (driver === undefined || !ROUTED_ACCOUNT_DRIVERS.has(driver)) return selection;
  const pick = (instanceId: ProviderInstanceId) =>
    instanceId === selection.instanceId ? selection : { ...selection, instanceId };
  const current = providers.find(
    (provider) => provider.instanceId === input.current && provider.driver === driver,
  );
  if (current !== undefined && !isAccountSpent(driver, current.usageLimits, input.now))
    return pick(current.instanceId);
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
  if (current !== undefined)
    return best !== undefined && hasKnownRoom(driver, best.usageLimits, input.now)
      ? pick(best.instanceId)
      : pick(current.instanceId);
  return best === undefined ? selection : pick(best.instanceId);
}

/** When each account a run failed on with a usage limit resets, in epoch milliseconds. */
type SpentAccounts = ReadonlyMap<ProviderInstanceId, number>;

/**
 * The providers with every account a usage limit stopped, and every instance of its subscription,
 * reading spent until that limit resets. The failure is the provider's own word; its readings can
 * miss it, since a later probe replaces the spent window and a failed one leaves it unknown.
 */
function withUsageLimitFailures(
  providers: ReadonlyArray<ServerProvider>,
  spentUntil: SpentAccounts | undefined,
  now: number,
): ReadonlyArray<ServerProvider> {
  if (spentUntil === undefined || spentUntil.size === 0) return providers;
  const keyOf = (provider: ServerProvider) =>
    accountKey(provider.driver, provider.auth.email, provider.usageLimits) ?? provider.instanceId;
  const resets = new Map<string, number>();
  for (const provider of providers) {
    const resetAt = spentUntil.get(provider.instanceId);
    if (resetAt === undefined || resetAt <= now) continue;
    const key = keyOf(provider);
    resets.set(key, Math.max(resets.get(key) ?? 0, resetAt));
  }
  const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  return providers.map((provider) => {
    const resetAt = resets.get(keyOf(provider));
    if (resetAt === undefined) return provider;
    const fingerprint = provider.usageLimits?.credentialFingerprint;
    return {
      ...provider,
      usageLimits: {
        checkedAt: iso(now),
        windows: [
          {
            id: "usage_limit",
            kind: "other",
            label: "Usage limit",
            usedPercent: 100,
            resetsAt: iso(resetAt),
          },
        ],
        ...(fingerprint === undefined ? {} : { credentialFingerprint: fingerprint }),
      },
    };
  });
}

/** Accounts this host's runs failed on with a usage limit that has not reset yet. */
const readSpentAccounts = (sql: SqlClient.SqlClient, now: number) =>
  sql<{ readonly providerInstanceId: string; readonly resetAt: string }>`
    SELECT run.provider_instance_id AS "providerInstanceId",
      MAX(json_extract(item.payload_json, '$.failure.resetAt')) AS "resetAt"
    FROM orchestration_v2_projection_turn_items item
    INNER JOIN orchestration_v2_projection_runs run ON run.run_id = item.run_id
    WHERE item.type = 'error' AND item.status = 'failed'
      AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
      AND julianday(json_extract(item.payload_json, '$.failure.resetAt'))
        > julianday(${DateTime.formatIso(DateTime.makeUnsafe(now))})
      AND run.provider_instance_id IS NOT NULL
    GROUP BY run.provider_instance_id
  `.pipe(
    Effect.map(
      (rows): SpentAccounts =>
        new Map(
          rows.map((row) => [
            ProviderInstanceId.make(row.providerInstanceId),
            Date.parse(row.resetAt),
          ]),
        ),
    ),
    Effect.catch((cause) =>
      Effect.as(Effect.logDebug("usage-limit failures unread for routing", { cause }), new Map()),
    ),
  );

const STALE_READING_MS = 15 * 60_000;
const REFRESH_SPACING_MS = 10 * 60_000;

/**
 * The routed driver of a selection whose accounts' usage readings are missing or older than
 * fifteen minutes. A host refreshes readings only while a client asks for provider status, so an
 * unattended host would otherwise route by readings from hours ago and send chats to accounts
 * that have since run out.
 */
export function staleRoutedDriver(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
  now: number,
): ServerProvider["driver"] | undefined {
  const driver = providers.find((provider) => provider.instanceId === selection.instanceId)?.driver;
  if (driver === undefined || !ROUTED_ACCOUNT_DRIVERS.has(driver)) return undefined;
  const stale = providers.some((provider) => {
    if (provider.driver !== driver || !provider.enabled) return false;
    const checkedAt = Date.parse(provider.usageLimits?.checkedAt ?? "");
    return !Number.isFinite(checkedAt) || now - checkedAt > STALE_READING_MS;
  });
  return stale ? driver : undefined;
}

/**
 * Routes a chat's selection with this host's settings, provider readings and running sessions,
 * refreshing a driver's stale readings first at most every ten minutes. Without a provider
 * registry, as in narrow test layers, selections pass through unchanged.
 */
export const makeAccountRouting = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const settings = yield* Effect.serviceOption(ServerSettingsService.ServerSettingsService);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const lastRefresh = yield* Ref.make(new Map<string, number>());
  return Effect.fn("accountRouting.route")(function* (request: AccountRequest) {
    if (Option.isNone(registry) || Option.isNone(settings)) return request.selection;
    const current = yield* settings.value.getSettings.pipe(Effect.option);
    if (Option.isNone(current) || !current.value.autoPickProviderAccounts) return request.selection;
    const now = yield* Clock.currentTimeMillis;
    let providers = yield* registry.value.getProviders;
    const stale = staleRoutedDriver(providers, request.selection, now);
    if (
      stale !== undefined &&
      now - ((yield* Ref.get(lastRefresh)).get(stale) ?? 0) > REFRESH_SPACING_MS
    ) {
      yield* Ref.update(lastRefresh, (map) => new Map(map).set(stale, now));
      const refreshed = yield* registry.value.refresh(stale).pipe(
        Effect.timeoutOption("20 seconds"),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isSome(refreshed)) providers = refreshed.value;
    }
    return routeSelection({
      ...request,
      settings: current.value,
      providers,
      now,
      ...(Option.isSome(sql)
        ? {
            load: yield* readLocalAccountLoad(sql.value),
            spentUntil: yield* readSpentAccounts(sql.value, now),
          }
        : {}),
    });
  });
});
