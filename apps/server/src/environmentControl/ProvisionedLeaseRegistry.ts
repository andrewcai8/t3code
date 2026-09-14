// @effect-diagnostics nodeBuiltinImport:off - this registry owns a small atomic state file at the server boundary.
// @effect-diagnostics globalDate:off - this registry uses ISO timestamps at the server boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
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
const StoredProvisionedLease = Schema.Struct({
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
      homeDir: Schema.optional(Schema.String),
    }),
  ),
  providerInstanceId: Schema.String,
  state: ProvisionedLeaseState,
  owner: Schema.NullOr(ProvisionedLeaseOwner),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
});
const StoredProvisionedLeases = Schema.Array(StoredProvisionedLease);
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

export function createProvisionedLeaseRegistry(path: string): ProvisionedLeaseRegistry {
  let mutation = Promise.resolve();

  const read = async (): Promise<ProvisionedLease[]> => {
    try {
      return [
        ...Schema.decodeUnknownSync(StoredProvisionedLeases)(
          JSON.parse(await NodeFSP.readFile(path, "utf8")),
        ),
      ];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
  };
  const write = async (leases: ReadonlyArray<ProvisionedLease>): Promise<void> => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
    await NodeFSP.writeFile(temporary, JSON.stringify(leases), { mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  };
  const mutate = <A>(
    fn: (
      leases: ProvisionedLease[],
    ) =>
      | Promise<{ leases: ProvisionedLease[]; value: A }>
      | { leases: ProvisionedLease[]; value: A },
  ): Promise<A> => {
    const result = mutation.then(async () => {
      const next = await fn(await read());
      await write(next.leases);
      return next.value;
    });
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const consistentRead = async <A>(fn: (leases: ProvisionedLease[]) => A): Promise<A> => {
    await mutation;
    return fn(await read());
  };

  return {
    register: (input) =>
      mutate((leases) => {
        const existing = leases.find((lease) => lease.leaseId === input.leaseId);
        if (existing) {
          if (
            existing.sandboxId !== input.sandboxId ||
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
            (input.now ?? new Date()).getTime() + LEASE_HEARTBEAT_TTL_MS,
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
        if (current.state !== "active" && current.state !== "paused")
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
        const updated: ProvisionedLease = {
          ...current,
          updatedAt: timestamp.toISOString(),
          expiresAt: new Date(timestamp.getTime() + LEASE_HEARTBEAT_TTL_MS).toISOString(),
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
          lease.leaseId === leaseId && (lease.state === "active" || lease.state === "paused")
            ? { ...lease, state: "missing" as const, updatedAt: nowIso(now) }
            : lease,
        ),
        value: undefined,
      })),
    markPaused: (leaseId, now) =>
      mutate((leases) => ({
        leases: leases.map((lease) =>
          lease.leaseId === leaseId && (lease.state === "active" || lease.state === "paused")
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
        // Heartbeat expiry pauses the lease. The provider resource remains recoverable.
        const expired = leases.filter(
          (lease) => lease.expiresAt <= cutoff && lease.state === "active",
        );
        return expired;
      }),
  };
}
