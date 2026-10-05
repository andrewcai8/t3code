import {
  type CloudMachineKind,
  DiscoveredProvisionedEnvironment,
  DurableProvisionRequest,
  EnvironmentControlError,
  type EnvironmentId,
  ProvisionOperationState,
  provisionSandboxId,
  type SavedEnvironmentAddress,
} from "@t3tools/contracts";
import { PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX } from "@t3tools/shared/remote";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { isLoopbackHostname } from "../http.ts";
import { cleanupPlan } from "./cloudCleanup.ts";
import { ProvisionedChatJson } from "./provisionedChats.ts";
import { restorableUntil, StoredProvisionedLease } from "./ProvisionedLeaseRegistry.ts";

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      request: Schema.fromJsonString(DurableProvisionRequest),
      state: Schema.fromJsonString(ProvisionOperationState),
      lease: Schema.fromJsonString(StoredProvisionedLease),
      chat: Schema.NullOr(Schema.String),
      chatSequence: Schema.NullOr(Schema.Number),
    }),
  ),
);
const decodeDiscovery = Schema.decodeUnknownEffect(DiscoveredProvisionedEnvironment);
const decodeChat = Schema.decodeUnknownExit(ProvisionedChatJson);

const GATEWAY_LEASE = new RegExp(`${PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX}/([^/]+)`);

/**
 * The saved environments a client dials at a box's own address: this host's gateway for the
 * box's lease, or the box's public origin. A loopback URL is a machine of the client's own.
 */
function savedBoxAddresses(addresses: ReadonlyArray<SavedEnvironmentAddress>) {
  const byLease = new Map<string, EnvironmentId>();
  const byOrigin = new Map<string, EnvironmentId>();
  for (const { environmentId, httpBaseUrl } of addresses) {
    const url = URL.canParse(httpBaseUrl) ? new URL(httpBaseUrl) : null;
    const lease = url?.pathname.match(GATEWAY_LEASE)?.[1];
    if (lease !== undefined) byLease.set(lease, environmentId);
    else if (url && !isLoopbackHostname(url.hostname)) byOrigin.set(url.origin, environmentId);
  }
  return { byLease, byOrigin };
}

/** A box's name in client lists: its repository's name and where it runs, as "Run on" names it. */
export function boxLabel(request: DurableProvisionRequest): string {
  const where = request.provider === "e2b" ? "E2B" : "Namespace Mac";
  const name = request.repository?.split("/").findLast((segment) => segment !== "");
  return name === undefined ? where : `${name} · ${where}`;
}

/** What a box runs on, which sets how long it takes to wake. */
export function boxMachine(request: DurableProvisionRequest): CloudMachineKind {
  if (request.provider === "e2b") return "sandbox";
  return request.engine === "instance" ? "mac" : "devbox";
}

/**
 * Discovery reads retained identities without renewing leases or issuing credentials. Of the
 * `known` environments, those that were this host's boxes and are gone come back as `disposed`,
 * matched by the environment id the box itself reported. A row disposed before that id was kept
 * is matched by the address one of `addresses` dials it at instead.
 *
 * With `chats`, a box that is not disposed also carries its owner's chat, unless the client holds
 * it at that sequence or a newer one. Without, no chat is sent.
 *
 * Each box also carries its cleanup under `afterDays`, the host's cloud machine cleanup setting.
 *
 * A removed box lists as `disposed` with the time it stays restorable, when it is one of `known`,
 * and with `removed` even when it is not.
 */
export const listProvisionedEnvironments = Effect.fn("ProvisionDiscovery.list")(
  function* (
    sql: SqlClient.SqlClient,
    known: ReadonlyArray<EnvironmentId> = [],
    addresses: ReadonlyArray<SavedEnvironmentAddress> = [],
    chats?: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly sequence: number }>,
    afterDays: number | null = null,
    removed = false,
  ) {
    const { byLease, byOrigin } = savedBoxAddresses(addresses);
    const heldChats =
      chats &&
      new Map<string, number>(
        chats.map(({ environmentId, sequence }) => [environmentId, sequence]),
      );
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql`
    SELECT operations.request_json AS request, operations.state_json AS state,
      leases.lease_json AS lease,
      ${
        // A paused Devbox's cleanup reads its chat's settle, so its card is read even unasked.
        heldChats
          ? sql`chats.chat_json`
          : sql`CASE WHEN json_extract(leases.lease_json, '$.state') = 'paused'
              AND json_extract(leases.lease_json, '$.namespaceResource') IS NOT NULL
              THEN chats.chat_json END`
      } AS chat, chats.sequence AS "chatSequence"
    FROM provision_operations AS operations
    JOIN provisioned_leases AS leases ON leases.lease_id = operations.request_id
    LEFT JOIN provisioned_chats AS chats ON chats.lease_id = leases.lease_id
    WHERE (json_extract(operations.state_json, '$.kind') = 'ready'
        AND (json_extract(leases.lease_json, '$.state') IN ('active', 'paused', 'missing', 'releasing')
          OR ${removed ? sql`json_extract(leases.lease_json, '$.state') = 'removed'` : sql`1 = 0`}
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
      OR (json_extract(operations.state_json, '$.kind') = 'disposed'
        AND json_extract(operations.state_json, '$.environmentId') IS NULL
        AND (${byLease.size === 0 ? sql`1 = 0` : sql`leases.lease_id IN ${sql.in([...byLease.keys()])}`}
          OR ${
            byOrigin.size === 0
              ? sql`1 = 0`
              : sql`json_extract(leases.lease_json, '$.remoteAccess.origin') IN ${sql.in([...byOrigin.keys()])}`
          }))
    ORDER BY operations.created_at DESC, operations.request_id
  `;
    const saved = new Set<string>([
      ...known,
      ...addresses.map(({ environmentId }) => environmentId),
    ]);
    const result: Array<DiscoveredProvisionedEnvironment> = [];
    const gone = new Map<string, DiscoveredProvisionedEnvironment>();
    for (const { request, state, lease, chat: chatJson, chatSequence } of yield* decodeRows(rows)) {
      let box: {
        readonly lifecycle: DiscoveredProvisionedEnvironment["lifecycle"];
        readonly environmentId: string;
        readonly projectDir?: string;
      } | null = null;
      if (state.kind === "ready") {
        const resource = state.allocation.resource;
        const expired = request.retentionDeadline !== undefined && request.retentionDeadline <= now;
        // A lease is `releasing` for as long as a pause takes. Its box stays listed as paused, so
        // a client does not take a pause for a deletion and forget the chat.
        const lifecycle =
          lease.state === "removed"
            ? "disposed"
            : !expired &&
                (lease.state === "active" || lease.state === "paused" || lease.state === "missing")
              ? lease.state
              : !expired && lease.state === "releasing"
                ? "paused"
                : saved.has(state.readiness.environmentId) &&
                    (lease.state === "disposed" || (expired && lease.state !== "releasing"))
                  ? "disposed"
                  : null;
        box =
          lifecycle === null || lease.sandboxId !== provisionSandboxId(resource)
            ? null
            : {
                lifecycle,
                environmentId: state.readiness.environmentId,
                projectDir: state.readiness.projectDir,
              };
      } else if (state.kind === "disposed") {
        // Only the id the box reported, or the address a client dials it at, names it. A claim's
        // owner is whatever a client said.
        const environmentId =
          state.environmentId ??
          byLease.get(lease.leaseId) ??
          (lease.remoteAccess && byOrigin.get(lease.remoteAccess.origin));
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
      // Only a chat newer than the client's, or one a paused Devbox's cleanup reads, is decoded.
      // One that no longer decodes is left out rather than failing the list.
      const sendChat =
        heldChats !== undefined &&
        chatSequence !== null &&
        box.lifecycle !== "disposed" &&
        (heldChats.get(box.environmentId) ?? -1) < chatSequence;
      const stored =
        chatJson !== null &&
        (sendChat || (lease.state === "paused" && lease.namespaceResource !== undefined))
          ? decodeChat(chatJson)
          : undefined;
      const owned =
        stored?._tag === "Success" && stored.value.thread.id === lease.owner?.threadId
          ? stored.value
          : undefined;
      const chat = sendChat ? owned : undefined;
      const cleanup =
        box.lifecycle === "disposed"
          ? null
          : cleanupPlan({ lease, thread: owned?.thread ?? null, afterDays });
      const discovered = yield* decodeDiscovery({
        requestId: request.requestId,
        leaseId: lease.leaseId,
        sandboxId: lease.sandboxId,
        lifecycle: box.lifecycle,
        environmentId: box.environmentId,
        provider: request.provider,
        machine: boxMachine(request),
        label: boxLabel(request),
        repository: request.repository ?? null,
        ...(box.projectDir === undefined ? {} : { projectDir: box.projectDir }),
        threadId: lease.owner?.threadId ?? null,
        createdAt: lease.createdAt,
        expiresAt:
          request.retentionDeadline !== undefined && request.retentionDeadline < lease.expiresAt
            ? request.retentionDeadline
            : lease.expiresAt,
      });
      const until = restorableUntil(lease);
      const environment = {
        ...discovered,
        ...(chat === undefined ? {} : { chat }),
        ...(cleanup === null ? {} : { cleanup }),
        ...(until === null ? {} : { restorableUntil: until }),
      };
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
