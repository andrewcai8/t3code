import { ProviderInstanceId } from "@t3tools/contracts";
import type { AccountLoad } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions.ts";
import type { ProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import type { ProvisionOperationStore } from "./ProvisionOperationStore.ts";

const boxAccounts = (box: {
  readonly providerInstanceId: string;
  readonly companionInstanceIds?: ReadonlyArray<string> | undefined;
}) =>
  [box.providerInstanceId, ...(box.companionInstanceIds ?? [])].map((id) =>
    ProviderInstanceId.make(id),
  );

/**
 * Sessions already running on each account, for routing a new cloud chat.
 *
 * A cloud box counts once against each account it runs, its chat's and
 * every companion driver's, as routing froze them into the box's request
 * rather than the account the request hinted at. It counts from the moment
 * its request is saved, minutes before it is ready, so a launch right after
 * another sees the first one's accounts as taken. A box being cancelled no
 * longer counts. A local thread counts while a turn is running on its
 * provider instance. A source that cannot be read counts as zero, so routing
 * degrades to usage alone instead of refusing.
 */
export const readAccountLoad = (
  leases: Pick<ProvisionedLeaseRegistry, "awake">,
  sessions: Pick<ProjectionThreadSessionRepositoryShape, "listRunning">,
  operations: Pick<ProvisionOperationStore["Service"], "listUnresolved">,
) =>
  Effect.all(
    {
      boxes: Effect.tryPromise(async () => (await leases.awake()).flatMap(boxAccounts)).pipe(
        Effect.catch((cause) =>
          Effect.as(Effect.logDebug("cloud leases unread for account load", { cause }), []),
        ),
      ),
      provisioning: operations.listUnresolved.pipe(
        Effect.map((unresolved) =>
          unresolved.flatMap((operation) =>
            operation.state.kind === "cancel_requested" ? [] : boxAccounts(operation.request),
          ),
        ),
        Effect.catch((cause) =>
          Effect.as(Effect.logDebug("provisioning boxes unread for account load", { cause }), []),
        ),
      ),
      local: sessions.listRunning().pipe(
        Effect.map((running) => running.flatMap((session) => session.providerInstanceId ?? [])),
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
