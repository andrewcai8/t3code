import { ProviderInstanceId } from "@t3tools/contracts";
import type { AccountLoad } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import { leaseAccounts, type ProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import type { ProvisionOperationStore } from "./ProvisionOperationStore.ts";

const requestAccounts = (request: {
  readonly providerInstanceId: string;
  readonly companionInstanceIds?: ReadonlyArray<string> | undefined;
}) =>
  [request.providerInstanceId, ...(request.companionInstanceIds ?? [])].map((id) =>
    ProviderInstanceId.make(id),
  );

/**
 * Sessions already running on each account, for routing a new cloud chat.
 *
 * A cloud box counts once against each account it runs, its chat's and
 * every companion driver's: the ones routing froze into its request, or the
 * ones an account switch moved it to since. It counts from the moment
 * its request is saved, minutes before it is ready, so a launch right after
 * another sees the first one's accounts as taken. A box being cancelled no
 * longer counts. A local thread counts once while it has a run in flight on
 * its provider instance: queued, preparing, starting, running or waiting. A source that cannot be read counts as zero, so routing
 * degrades to usage alone instead of refusing.
 */
export const readAccountLoad = (
  leases: Pick<ProvisionedLeaseRegistry, "awake">,
  sql: SqlClient.SqlClient,
  operations: Pick<ProvisionOperationStore["Service"], "listUnresolved">,
) =>
  Effect.all(
    {
      boxes: Effect.tryPromise(async () =>
        (await leases.awake()).flatMap((lease) =>
          leaseAccounts(lease).map((id) => ProviderInstanceId.make(id)),
        ),
      ).pipe(
        Effect.catch((cause) =>
          Effect.as(Effect.logDebug("cloud leases unread for account load", { cause }), []),
        ),
      ),
      provisioning: operations.listUnresolved.pipe(
        Effect.map((unresolved) =>
          unresolved.flatMap((operation) =>
            operation.state.kind === "cancel_requested" ? [] : requestAccounts(operation.request),
          ),
        ),
        Effect.catch((cause) =>
          Effect.as(Effect.logDebug("provisioning boxes unread for account load", { cause }), []),
        ),
      ),
      local: sql<{ readonly providerInstanceId: string; readonly threads: number }>`
        SELECT provider_instance_id AS "providerInstanceId", COUNT(DISTINCT thread_id) AS threads
        FROM orchestration_v2_projection_runs
        WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          AND provider_instance_id IS NOT NULL
        GROUP BY provider_instance_id
      `.pipe(
        Effect.map((rows) =>
          rows.flatMap(({ providerInstanceId, threads }) =>
            Array.from({ length: threads }, () => ProviderInstanceId.make(providerInstanceId)),
          ),
        ),
        Effect.catch((cause) =>
          Effect.as(Effect.logDebug("local sessions unread for account load", { cause }), []),
        ),
      ),
    },
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(({ boxes, provisioning, local }) => {
      const load = new Map<ProviderInstanceId, number>();
      for (const id of [...boxes, ...provisioning, ...local]) load.set(id, (load.get(id) ?? 0) + 1);
      return load satisfies AccountLoad;
    }),
  );
