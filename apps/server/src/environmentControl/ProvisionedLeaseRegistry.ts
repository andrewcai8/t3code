// @effect-diagnostics nodeBuiltinImport:off - this registry owns a small atomic state file at the server boundary.
// @effect-diagnostics globalDate:off - this registry uses ISO timestamps at the server boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

export const ProvisionedLeaseState = Schema.Literals(["active", "releasing", "disposed"]);
export type ProvisionedLeaseState = typeof ProvisionedLeaseState.Type;

const ProvisionedLeaseOwner = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
});
const StoredProvisionedLease = Schema.Struct({
  leaseId: Schema.String,
  sandboxId: Schema.String,
  providerInstanceId: Schema.String,
  state: ProvisionedLeaseState,
  owner: Schema.NullOr(ProvisionedLeaseOwner),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  expiresAt: Schema.String,
});
const StoredProvisionedLeases = Schema.Array(StoredProvisionedLease);

export type ProvisionedLease = typeof StoredProvisionedLease.Type;
export type ProvisionedLeaseOwner = typeof ProvisionedLeaseOwner.Type;

export interface ProvisionedLeaseRegistry {
  readonly register: (input: {
    readonly leaseId: string;
    readonly sandboxId: string;
    readonly providerInstanceId: string;
    readonly now?: Date;
  }) => Promise<ProvisionedLease>;
  readonly claim: (input: {
    readonly leaseId: string;
    readonly owner: ProvisionedLeaseOwner;
    readonly now?: Date;
  }) => Promise<ProvisionedLease | null>;
  readonly touch: (leaseId: string, now?: Date) => Promise<ProvisionedLease | null>;
  readonly findBySandbox: (sandboxId: string) => Promise<ProvisionedLease | null>;
  readonly beginRelease: (input: {
    readonly leaseId?: string | undefined;
    readonly sandboxId: string;
    readonly now?: Date;
  }) => Promise<"missing" | "disposed" | "started" | "busy">;
  readonly markDisposed: (leaseId: string, now?: Date) => Promise<void>;
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
            existing.providerInstanceId !== input.providerInstanceId
          ) {
            throw new Error("Provisioned lease identity conflict");
          }
          return { leases, value: existing };
        }
        const now = nowIso(input.now);
        const lease: ProvisionedLease = {
          leaseId: input.leaseId,
          sandboxId: input.sandboxId,
          providerInstanceId: input.providerInstanceId,
          state: "active",
          owner: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date((input.now ?? new Date()).getTime() + 60 * 60 * 1000).toISOString(),
        };
        return { leases: [...leases, lease], value: lease };
      }),
    claim: (input) =>
      mutate((leases) => {
        const index = leases.findIndex((lease) => lease.leaseId === input.leaseId);
        if (index < 0) return { leases, value: null };
        const current = leases[index];
        if (!current) return { leases, value: null };
        if (current.state !== "active") return { leases, value: null };
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
        if (!current || current.state !== "active" || current.owner === null)
          return { leases, value: null };
        const timestamp = now ?? new Date();
        const updated: ProvisionedLease = {
          ...current,
          updatedAt: timestamp.toISOString(),
          expiresAt: new Date(timestamp.getTime() + 60 * 60 * 1000).toISOString(),
        };
        const next = [...leases];
        next[index] = updated;
        return { leases: next, value: updated };
      }),
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
