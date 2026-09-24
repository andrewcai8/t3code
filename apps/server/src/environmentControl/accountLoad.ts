import { ProviderInstanceId } from "@t3tools/contracts";
import type { AccountLoad } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions.ts";
import type { ProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";

/**
 * Sessions already running on each account, for routing a new cloud chat.
 *
 * An awake cloud box counts once against each account it runs, its chat's
 * and every companion driver's, as routing froze them into the box's
 * manifest rather than the account the request hinted at. A local thread
 * counts while a turn is running on its provider instance. A source that
 * cannot be read counts as zero, so routing degrades to usage alone instead
 * of refusing.
 */
export const readAccountLoad = (
  leases: Pick<ProvisionedLeaseRegistry, "awake">,
  sessions: Pick<ProjectionThreadSessionRepositoryShape, "listRunning">,
) =>
  Effect.all(
    {
      boxes: Effect.tryPromise(async () =>
        (await leases.awake()).flatMap((lease) =>
          [lease.providerInstanceId, ...(lease.companionInstanceIds ?? [])].map((id) =>
            ProviderInstanceId.make(id),
          ),
        ),
      ).pipe(
        Effect.catch((cause) =>
          Effect.as(Effect.logDebug("cloud leases unread for account load", { cause }), []),
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
    Effect.map(({ boxes, local }) => {
      const load = new Map<ProviderInstanceId, number>();
      for (const id of [...boxes, ...local]) load.set(id, (load.get(id) ?? 0) + 1);
      return load satisfies AccountLoad;
    }),
  );
