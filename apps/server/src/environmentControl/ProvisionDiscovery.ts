import {
  DiscoveredProvisionedEnvironment,
  DurableProvisionRequest,
  EnvironmentControlError,
  ProvisionOperationState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { StoredProvisionedLease } from "./ProvisionedLeaseRegistry.ts";

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      request: Schema.fromJsonString(DurableProvisionRequest),
      state: Schema.fromJsonString(ProvisionOperationState),
      lease: Schema.fromJsonString(StoredProvisionedLease),
    }),
  ),
);
const decodeDiscovery = Schema.decodeUnknownEffect(DiscoveredProvisionedEnvironment);

/** Discovery reads retained identities without renewing leases or issuing credentials. */
export const listProvisionedEnvironments = Effect.fn("ProvisionDiscovery.list")(
  function* (sql: SqlClient.SqlClient) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql`
    SELECT operations.request_json AS request, operations.state_json AS state,
      leases.lease_json AS lease
    FROM provision_operations AS operations
    JOIN provisioned_leases AS leases ON leases.lease_id = operations.request_id
    WHERE json_extract(operations.state_json, '$.kind') = 'ready'
      AND json_extract(leases.lease_json, '$.state') IN ('active', 'paused', 'missing')
    ORDER BY operations.created_at DESC, operations.request_id
  `;
    const result: Array<DiscoveredProvisionedEnvironment> = [];
    for (const { request, state, lease } of yield* decodeRows(rows)) {
      if (
        state.kind !== "ready" ||
        (request.retentionDeadline !== undefined && request.retentionDeadline <= now)
      )
        continue;
      if (lease.state !== "active" && lease.state !== "paused" && lease.state !== "missing")
        continue;
      const resource = state.allocation.resource;
      const sandboxId = resource.provider === "e2b" ? resource.sandboxId : resource.devboxId;
      if (
        lease.leaseId !== request.requestId ||
        lease.sandboxId !== sandboxId ||
        lease.provider !== resource.provider ||
        lease.providerInstanceId !== request.providerInstanceId ||
        (lease.owner !== null && lease.owner.environmentId !== state.readiness.environmentId)
      )
        continue;
      result.push(
        yield* decodeDiscovery({
          requestId: request.requestId,
          leaseId: lease.leaseId,
          sandboxId: lease.sandboxId,
          lifecycle: lease.state,
          environmentId: state.readiness.environmentId,
          provider: resource.provider,
          label:
            request.repository ??
            `${resource.provider === "e2b" ? "E2B" : "Namespace"} · ${request.requestId.slice(0, 8)}`,
          repository: request.repository ?? null,
          projectDir: state.readiness.projectDir,
          threadId: lease.owner?.threadId ?? null,
          createdAt: lease.createdAt,
          expiresAt:
            request.retentionDeadline !== undefined && request.retentionDeadline < lease.expiresAt
              ? request.retentionDeadline
              : lease.expiresAt,
        }),
      );
    }
    return result;
  },
  Effect.mapError(
    () => new EnvironmentControlError({ message: "Provisioned environments could not be listed." }),
  ),
);
