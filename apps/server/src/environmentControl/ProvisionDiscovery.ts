import {
  DiscoveredProvisionedEnvironment,
  DurableProvisionRequest,
  EnvironmentControlError,
  type EnvironmentId,
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
      automationId: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeDiscovery = Schema.decodeUnknownEffect(DiscoveredProvisionedEnvironment);

/**
 * Discovery reads retained identities without renewing leases or issuing credentials. Of the
 * `known` environments, those that were this host's boxes and are gone come back as `disposed`,
 * matched only by the environment id the box itself reported. Rows disposed before that id was
 * kept name nothing.
 */
export const listProvisionedEnvironments = Effect.fn("ProvisionDiscovery.list")(
  function* (sql: SqlClient.SqlClient, known: ReadonlyArray<EnvironmentId> = []) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql`
    SELECT operations.request_json AS request, operations.state_json AS state,
      leases.lease_json AS lease, runs.automation_id AS "automationId"
    FROM provision_operations AS operations
    JOIN provisioned_leases AS leases ON leases.lease_id = operations.request_id
    LEFT JOIN automation_runs AS runs ON runs.request_id = operations.request_id
    WHERE (json_extract(operations.state_json, '$.kind') = 'ready'
        AND (json_extract(leases.lease_json, '$.state') IN ('active', 'paused', 'missing')
          OR ${
            known.length === 0
              ? sql`1 = 0`
              : sql`json_extract(operations.state_json, '$.readiness.environmentId') IN ${sql.in(known)}`
          }))
      OR ${
        known.length === 0
          ? sql`1 = 0`
          : sql`(json_extract(operations.state_json, '$.kind') = 'disposed'
        AND json_extract(operations.state_json, '$.environmentId') IN ${sql.in(known)})`
      }
    ORDER BY operations.created_at DESC, operations.request_id
  `;
    const saved = new Set<string>(known);
    const result: Array<DiscoveredProvisionedEnvironment> = [];
    const gone = new Map<string, DiscoveredProvisionedEnvironment>();
    for (const { request, state, lease, automationId } of yield* decodeRows(rows)) {
      let box: {
        readonly lifecycle: DiscoveredProvisionedEnvironment["lifecycle"];
        readonly environmentId: string;
        readonly projectDir?: string;
      } | null = null;
      if (state.kind === "ready") {
        const resource = state.allocation.resource;
        const expired = request.retentionDeadline !== undefined && request.retentionDeadline <= now;
        const lifecycle =
          !expired &&
          (lease.state === "active" || lease.state === "paused" || lease.state === "missing")
            ? lease.state
            : saved.has(state.readiness.environmentId) &&
                (lease.state === "disposed" || (expired && lease.state !== "releasing"))
              ? "disposed"
              : null;
        box =
          lifecycle === null ||
          lease.sandboxId !== (resource.provider === "e2b" ? resource.sandboxId : resource.devboxId)
            ? null
            : {
                lifecycle,
                environmentId: state.readiness.environmentId,
                projectDir: state.readiness.projectDir,
              };
      } else if (state.kind === "disposed") {
        // Only the id the box reported names it. A claim's owner is whatever a client said.
        const environmentId = state.environmentId;
        box =
          environmentId !== undefined && saved.has(environmentId)
            ? { lifecycle: "disposed", environmentId }
            : null;
      }
      if (
        box === null ||
        lease.leaseId !== request.requestId ||
        lease.provider !== request.provider ||
        lease.providerInstanceId !== request.providerInstanceId ||
        (lease.owner !== null && lease.owner.environmentId !== box.environmentId)
      )
        continue;
      const environment = yield* decodeDiscovery({
        requestId: request.requestId,
        leaseId: lease.leaseId,
        sandboxId: lease.sandboxId,
        lifecycle: box.lifecycle,
        environmentId: box.environmentId,
        provider: request.provider,
        label:
          request.repository ??
          `${request.provider === "e2b" ? "E2B" : "Namespace"} · ${request.requestId.slice(0, 8)}`,
        repository: request.repository ?? null,
        ...(box.projectDir === undefined ? {} : { projectDir: box.projectDir }),
        threadId: lease.owner?.threadId ?? null,
        ...(automationId === null ? {} : { automationId }),
        createdAt: lease.createdAt,
        expiresAt:
          request.retentionDeadline !== undefined && request.retentionDeadline < lease.expiresAt
            ? request.retentionDeadline
            : lease.expiresAt,
      });
      if (box.lifecycle !== "disposed") result.push(environment);
      else if (!gone.has(environment.environmentId))
        gone.set(environment.environmentId, environment);
    }
    const live = new Set(result.map((environment) => environment.environmentId));
    return [
      ...result,
      ...[...gone.values()].filter(({ environmentId }) => !live.has(environmentId)),
    ];
  },
  Effect.mapError(
    () => new EnvironmentControlError({ message: "Provisioned environments could not be listed." }),
  ),
);
