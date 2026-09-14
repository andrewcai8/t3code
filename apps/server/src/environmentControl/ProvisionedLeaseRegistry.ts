// @effect-diagnostics globalDate:off - this registry uses ISO timestamps at the server boundary.
import { EnvironmentProvisionInput } from "@t3tools/contracts";
import { retentionExpired } from "./retention.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { NamespaceResource } from "./namespaceProvisioner.ts";

export const ProvisionedLeaseState = Schema.Literals([
  "active",
  "paused",
  "missing",
  "releasing",
  "disposed",
]);
export type ProvisionedLeaseState = typeof ProvisionedLeaseState.Type;

const ProvisionedLeaseOwner = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
});
export const StoredProvisionedLease = Schema.Struct({
  leaseId: Schema.String,
  sandboxId: Schema.String,
  provider: Schema.optional(Schema.Literals(["e2b", "namespace"])),
  namespaceProxy: Schema.optional(
    Schema.Struct({ proxyId: Schema.String, proxyOrigin: Schema.String }),
  ),
  namespaceResource: Schema.optional(
    Schema.Struct({
      provider: Schema.Literal("namespace"),
      devboxId: Schema.String,
      devboxName: Schema.optional(Schema.String),
      instanceId: Schema.String,
      region: Schema.String,
      workspaceDir: Schema.String,
    }),
  ),
  providerInstanceId: Schema.String,
  state: ProvisionedLeaseState,
  owner: Schema.NullOr(ProvisionedLeaseOwner),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
  retentionDeadline: EnvironmentProvisionInput.fields.retentionDeadline,
});
const StoredProvisionedLeases = Schema.Array(StoredProvisionedLease);
const decodeLeases = Schema.decodeUnknownSync(StoredProvisionedLeases);
export const decodeLegacyLeases = Schema.decodeUnknownSync(
  Schema.fromJsonString(StoredProvisionedLeases),
);
const LEASE_HEARTBEAT_TTL_MS = 15 * 60 * 1000;

export type ProvisionedLease = typeof StoredProvisionedLease.Type;
export type ProvisionedLeaseOwner = typeof ProvisionedLeaseOwner.Type;

export interface ProvisionedLeaseRegistry {
  readonly register: (input: {
    readonly leaseId: string;
    readonly sandboxId: string;
    readonly providerInstanceId: string;
    readonly provider?: "e2b" | "namespace";
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
    readonly namespaceResource?: NamespaceResource;
    readonly retentionDeadline?: string;
    readonly now?: Date;
  }) => Promise<ProvisionedLease>;
  readonly claim: (input: {
    readonly leaseId: string;
    readonly owner: ProvisionedLeaseOwner;
    readonly now?: Date;
  }) => Promise<ProvisionedLease | null>;
  readonly touch: (leaseId: string, now?: Date) => Promise<ProvisionedLease | null>;
  readonly findById: (leaseId: string) => Promise<ProvisionedLease | null>;
  readonly findBySandbox: (sandboxId: string) => Promise<ProvisionedLease | null>;
  readonly beginRelease: (input: {
    readonly leaseId?: string | undefined;
    readonly sandboxId: string;
    readonly now?: Date;
  }) => Promise<"missing" | "disposed" | "started" | "busy">;
  readonly markDisposed: (leaseId: string, now?: Date) => Promise<void>;
  readonly markMissing: (leaseId: string, now?: Date) => Promise<void>;
  readonly markPaused: (leaseId: string, now?: Date) => Promise<void>;
  readonly markActive: (input: {
    readonly leaseId: string;
    readonly namespaceResource?: NamespaceResource;
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
    readonly now?: Date;
  }) => Promise<ProvisionedLease | null>;
  readonly expired: (now?: Date) => Promise<ReadonlyArray<ProvisionedLease>>;
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export function createProvisionedLeaseRegistry(
  sql: SqlClient.SqlClient,
  legacyJson = "[]",
): ProvisionedLeaseRegistry {
  const legacy = decodeLegacyLeases(legacyJson);
  let imported: Promise<void> | undefined;
  const initialize = () =>
    (imported ??= (async () => {
      for (const lease of legacy)
        await Effect.runPromise(
          sql`INSERT INTO provisioned_leases (lease_id, lease_json) VALUES (${lease.leaseId}, ${JSON.stringify(lease)}) ON CONFLICT(lease_id) DO NOTHING`,
        );
    })());
  const read = async () => {
    await initialize();
    const rows = await Effect.runPromise(
      sql<{ lease_json: string }>`SELECT lease_json FROM provisioned_leases`,
    );
    const leases = [...decodeLeases(rows.map((row) => JSON.parse(row.lease_json)))];
    return {
      leases,
      bodies: new Map(leases.map((lease, index) => [lease.leaseId, rows[index]!.lease_json])),
    };
  };
  const mutate = async <A>(
    fn: (
      leases: ProvisionedLease[],
    ) =>
      | Promise<{ leases: ProvisionedLease[]; value: A }>
      | { leases: ProvisionedLease[]; value: A },
  ): Promise<A> => {
    for (;;) {
      const snapshot = await read();
      const previous = snapshot.leases;
      const next = await fn(previous);
      const changed = next.leases.filter(
        (lease) =>
          JSON.stringify(lease) !==
          JSON.stringify(previous.find((item) => item.leaseId === lease.leaseId)),
      );
      if (changed.length === 0) return next.value;
      if (changed.length !== 1) throw new Error("A lease mutation must name one lease.");
      const lease = changed[0]!;
      const before = previous.find((item) => item.leaseId === lease.leaseId);
      const rows = before
        ? await Effect.runPromise(
            sql`UPDATE provisioned_leases SET lease_json = ${JSON.stringify(lease)} WHERE lease_id = ${lease.leaseId} AND lease_json = ${snapshot.bodies.get(before.leaseId)} RETURNING lease_id`,
          )
        : await Effect.runPromise(
            sql`INSERT INTO provisioned_leases (lease_id, lease_json) VALUES (${lease.leaseId}, ${JSON.stringify(lease)}) ON CONFLICT(lease_id) DO NOTHING RETURNING lease_id`,
          );
      if (rows.length === 1) return next.value;
    }
  };
  const consistentRead = async <A>(fn: (leases: ProvisionedLease[]) => A): Promise<A> =>
    fn((await read()).leases);

  return {
    register: (input) =>
      mutate((leases) => {
        const existing = leases.find((lease) => lease.leaseId === input.leaseId);
        if (existing) {
          if (
            existing.sandboxId !== input.sandboxId ||
            existing.retentionDeadline !== input.retentionDeadline ||
            existing.providerInstanceId !== input.providerInstanceId ||
            existing.provider !== input.provider ||
            existing.namespaceProxy?.proxyId !== input.namespaceProxy?.proxyId ||
            existing.namespaceProxy?.proxyOrigin !== input.namespaceProxy?.proxyOrigin
          ) {
            throw new Error("Provisioned lease identity conflict");
          }
          return { leases, value: existing };
        }
        const now = nowIso(input.now);
        const lease: ProvisionedLease = {
          ...(input.retentionDeadline === undefined
            ? {}
            : { retentionDeadline: input.retentionDeadline }),
          leaseId: input.leaseId,
          sandboxId: input.sandboxId,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
          ...(input.namespaceProxy === undefined ? {} : { namespaceProxy: input.namespaceProxy }),
          ...(input.namespaceResource === undefined
            ? {}
            : { namespaceResource: input.namespaceResource }),
          providerInstanceId: input.providerInstanceId,
          state: "active",
          owner: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(
            Math.min(
              (input.now ?? new Date()).getTime() + LEASE_HEARTBEAT_TTL_MS,
              input.retentionDeadline === undefined
                ? Infinity
                : Date.parse(input.retentionDeadline),
            ),
          ).toISOString(),
        };
        return { leases: [...leases, lease], value: lease };
      }),
    claim: (input) =>
      mutate((leases) => {
        const index = leases.findIndex((lease) => lease.leaseId === input.leaseId);
        if (index < 0) return { leases, value: null };
        const current = leases[index];
        if (!current) return { leases, value: null };
        if (
          (current.state !== "active" && current.state !== "paused") ||
          retentionExpired(current.retentionDeadline, (input.now ?? new Date()).getTime())
        )
          return { leases, value: null };
        if (
          current.owner !== null &&
          (current.owner.environmentId !== input.owner.environmentId ||
            current.owner.threadId !== input.owner.threadId)
        )
          return { leases, value: null };
        const updated: ProvisionedLease = {
          ...current,
          owner: input.owner,
          updatedAt: nowIso(input.now),
        };
        const next = [...leases];
        next[index] = updated;
        return { leases: next, value: updated };
      }),
    touch: (leaseId, now) =>
      mutate((leases) => {
        const index = leases.findIndex((lease) => lease.leaseId === leaseId);
        const current = index < 0 ? undefined : leases[index];
        if (
          !current ||
          (current.state !== "active" && current.state !== "paused") ||
          current.owner === null
        )
          return { leases, value: null };
        const timestamp = now ?? new Date();
        if (retentionExpired(current.retentionDeadline, timestamp.getTime()))
          return { leases, value: null };
        const updated: ProvisionedLease = {
          ...current,
          updatedAt: timestamp.toISOString(),
          expiresAt: new Date(
            Math.min(
              timestamp.getTime() + LEASE_HEARTBEAT_TTL_MS,
              current.retentionDeadline === undefined
                ? Infinity
                : Date.parse(current.retentionDeadline),
            ),
          ).toISOString(),
        };
        const next = [...leases];
        next[index] = updated;
        return { leases: next, value: updated };
      }),
    findById: (leaseId) =>
      consistentRead((leases) => leases.find((lease) => lease.leaseId === leaseId) ?? null),
    findBySandbox: (sandboxId) =>
      consistentRead((leases) => leases.find((lease) => lease.sandboxId === sandboxId) ?? null),
    beginRelease: (input) =>
      mutate((leases) => {
        const current = leases.find(
          (lease) =>
            lease.sandboxId === input.sandboxId &&
            (input.leaseId === undefined || lease.leaseId === input.leaseId),
        );
        if (!current) return { leases, value: "missing" as const };
        if (current.state === "disposed") return { leases, value: "disposed" as const };
        if (current.state === "releasing") return { leases, value: "busy" as const };
        const updated = { ...current, state: "releasing" as const, updatedAt: nowIso(input.now) };
        return {
          leases: leases.map((lease) => (lease.leaseId === current.leaseId ? updated : lease)),
          value: "started" as const,
        };
      }),
    markDisposed: (leaseId, now) =>
      mutate((leases) => ({
        leases: leases.map((lease) =>
          lease.leaseId === leaseId
            ? { ...lease, state: "disposed" as const, updatedAt: nowIso(now) }
            : lease,
        ),
        value: undefined,
      })),
    markMissing: (leaseId, now) =>
      mutate((leases) => ({
        leases: leases.map((lease) =>
          lease.leaseId === leaseId &&
          (lease.state === "active" || lease.state === "paused" || lease.state === "releasing")
            ? { ...lease, state: "missing" as const, updatedAt: nowIso(now) }
            : lease,
        ),
        value: undefined,
      })),
    markPaused: (leaseId, now) =>
      mutate((leases) => ({
        leases: leases.map((lease) =>
          lease.leaseId === leaseId &&
          (lease.state === "active" || lease.state === "paused" || lease.state === "releasing")
            ? { ...lease, state: "paused" as const, updatedAt: nowIso(now) }
            : lease,
        ),
        value: undefined,
      })),
    markActive: (input) =>
      mutate((leases) => {
        const current = leases.find((lease) => lease.leaseId === input.leaseId);
        if (!current || (current.state !== "active" && current.state !== "paused"))
          return { leases, value: null };
        if (
          (input.namespaceResource &&
            input.namespaceResource.devboxId !== current.namespaceResource?.devboxId) ||
          (input.namespaceProxy &&
            (input.namespaceProxy.proxyId !== current.namespaceProxy?.proxyId ||
              input.namespaceProxy.proxyOrigin !== current.namespaceProxy?.proxyOrigin))
        )
          throw new Error("Provisioned lease identity conflict");
        const now = input.now ?? new Date();
        const updated: ProvisionedLease = {
          ...current,
          ...(input.namespaceResource ? { namespaceResource: input.namespaceResource } : {}),
          ...(input.namespaceProxy ? { namespaceProxy: input.namespaceProxy } : {}),
          state: "active",
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + LEASE_HEARTBEAT_TTL_MS).toISOString(),
        };
        return {
          leases: leases.map((lease) => (lease.leaseId === current.leaseId ? updated : lease)),
          value: updated,
        };
      }),
    expired: (now) =>
      consistentRead((leases) => {
        const cutoff = (now ?? new Date()).toISOString();
        // An expired active lease is recoverable when its heartbeat stops.
        return leases.filter(
          (lease) =>
            lease.expiresAt <= cutoff && (lease.state === "releasing" || lease.state === "active"),
        );
      }),
  };
}
