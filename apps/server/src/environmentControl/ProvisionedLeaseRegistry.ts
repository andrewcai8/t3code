// @effect-diagnostics globalDate:off - this registry uses ISO timestamps at the server boundary.
import { EnvironmentProvisionInput } from "@t3tools/contracts";
import { retentionExpired } from "./retention.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { NamespaceResource } from "./namespaceProvisioner.ts";

export const ProvisionedLeaseState = Schema.Literals([
  "active",
  "paused",
  "missing",
  "releasing",
  "removed",
  "disposed",
]);
export type ProvisionedLeaseState = typeof ProvisionedLeaseState.Type;

export const FirstTurnState = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["pending", "started"]) }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: Schema.String }),
]);
export type FirstTurnState = typeof FirstTurnState.Type;
/** A first turn the box has not taken this long after its lease began is given up on. */
const FIRST_TURN_DEADLINE_MS = 30 * 60_000;
/** Whether a lease's first turn is still owed and its deadline has passed. */
export const firstTurnOverdue = (lease: ProvisionedLease, now: number) =>
  lease.firstTurn?.status === "pending" &&
  now - Date.parse(lease.createdAt) > FIRST_TURN_DEADLINE_MS;

/**
 * How long a chat's removed box stays asleep and restorable. Lease upkeep deletes it for good
 * after that.
 */
const REMOVED_GRACE_MS = 30 * 86_400_000;
/** When a removed lease's box is deleted for good; null for any lease that is not removed. */
export const restorableUntil = (lease: ProvisionedLease): string | null =>
  lease.state === "removed" && lease.removedAt !== undefined
    ? new Date(Date.parse(lease.removedAt) + REMOVED_GRACE_MS).toISOString()
    : null;
/**
 * Whether removing a lease's box only puts it to sleep, restorable: a chat owns it and something
 * has run on it. Any other box is deleted at once.
 */
export const keepsRemovedBox = (lease: ProvisionedLease): boolean =>
  lease.owner !== null && lease.firstTurn?.status !== "pending";

/**
 * Why a paused box is exempt from cleanup: its owner asked to keep it, or its work could not be
 * backed up before removal. Waking clears `unsaved-work`, since the box may have changed.
 */
export const LeaseKeep = Schema.Literals(["user", "unsaved-work"]);
export type LeaseKeep = typeof LeaseKeep.Type;

/** A run a switch handled, and the account it hit its limit on when the host still has it. */
const AccountLimit = Schema.Struct({
  instanceId: Schema.optional(Schema.String),
  runId: Schema.String,
  until: Schema.String,
});
export type AccountLimit = typeof AccountLimit.Type;

/**
 * The box's latest backup, taken after a turn or before it slept: its unsaved work on `t3-backup/`
 * branches or in a bundle, and its owner chat's provider sessions with a manifest restore reads
 * under `sessionsUri`. A record this build cannot read is dropped rather than failing the lease.
 */
export const LeaseBackup = Schema.Struct({
  /** When the backup that last changed this record finished. */
  at: Schema.String,
  /** Branches on a private origin holding work only the box had; empty when there were none. */
  branches: Schema.Array(Schema.String),
  sessionsUri: Schema.optional(Schema.String),
  /** What each part held when saved, so a box unchanged since is not saved again. */
  workFingerprint: Schema.optional(Schema.String),
  sessionsFingerprint: Schema.optional(Schema.String),
});
export type LeaseBackup = typeof LeaseBackup.Type;

/**
 * The one rebuild of a chat whose box its provider could not start: `started`, then `done` with
 * the lease, environment and thread that carry the chat on, or `failed`. A lease that has one is
 * never rebuilt again; its own box is left paused.
 */
export const LeaseRebuild = Schema.Struct({
  status: Schema.Literals(["started", "done", "failed"]),
  at: Schema.String,
  leaseId: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type LeaseRebuild = typeof LeaseRebuild.Type;

/**
 * The fresh boot of a box E2B could not resume, at most one per outage: a resume that succeeds
 * ends the outage and clears it.
 */
export const LeaseReboot = Schema.Struct({
  status: Schema.Literals(["started", "done", "failed"]),
  at: Schema.String,
  reason: Schema.optional(Schema.String),
});
export type LeaseReboot = typeof LeaseReboot.Type;

/**
 * A pause that saved only the box's disk, because its memory was unsafe to keep, so it wakes as a
 * fresh boot. Kept until its chat is told what that lost.
 */
export const LeaseDiskPause = Schema.Struct({
  at: Schema.String,
  reason: Schema.String,
});
export type LeaseDiskPause = typeof LeaseDiskPause.Type;

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
  /**
   * Where the manager reads the remote agent's activity. The broker token is
   * an admin credential: keep it in this private record, never in RPC or logs.
   */
  remoteAccess: Schema.optional(
    Schema.Struct({ origin: Schema.String, brokerToken: Schema.String }),
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
  /** The account the request routed to, part of the box's identity; `accounts` names the live one. */
  providerInstanceId: Schema.String,
  companionInstanceIds: Schema.optional(Schema.Array(Schema.String)),
  /**
   * The host accounts the box runs now, one per driver, once an account switch moved one. Absent
   * means the ones it was provisioned with. Read it through `leaseAccounts`.
   */
  accounts: Schema.optional(Schema.Array(Schema.String)),
  /**
   * Accounts a chat on this box ran out of usage on, each with the run that stopped and when the
   * account is usable again. A switch never moves back onto one before then, and handles a run once.
   */
  accountLimits: Schema.optional(Schema.Array(AccountLimit)),
  state: ProvisionedLeaseState,
  owner: Schema.NullOr(ProvisionedLeaseOwner),
  /**
   * The host's start of the owner's first turn. A lease whose turn is `pending` is not idle,
   * since nothing has run on it yet, until FIRST_TURN_DEADLINE_MS after it began.
   */
  firstTurn: Schema.optional(FirstTurnState),
  keep: Schema.optional(LeaseKeep),
  /**
   * Moves upkeep made in a row to keep a working chat on a new Mac, with no client heartbeat or
   * resume since the first of them. Absent means none.
   */
  unwatchedMoves: Schema.optional(Schema.Int),
  backup: Schema.optional(
    LeaseBackup.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
  rebuild: Schema.optional(
    LeaseRebuild.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
  reboot: Schema.optional(
    LeaseReboot.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
  diskPause: Schema.optional(
    LeaseDiskPause.pipe(Schema.catchDecoding(() => Effect.succeed(Option.none()))),
  ),
  /** When the lease's box was removed; present exactly while `state` is `removed`. */
  removedAt: Schema.optional(Schema.String),
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
export type RemoteAccess = NonNullable<ProvisionedLease["remoteAccess"]>;

/** The host accounts a box runs now, the chat's driver first. */
export const leaseAccounts = (lease: ProvisionedLease): ReadonlyArray<string> =>
  lease.accounts ?? [lease.providerInstanceId, ...(lease.companionInstanceIds ?? [])];

export interface ProvisionedLeaseRegistry {
  readonly register: (input: {
    readonly leaseId: string;
    readonly sandboxId: string;
    readonly providerInstanceId: string;
    readonly companionInstanceIds?: ReadonlyArray<string>;
    readonly provider?: "e2b" | "namespace";
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
    readonly namespaceResource?: NamespaceResource;
    readonly retentionDeadline?: string;
    /** The chat the box was provisioned for, which owns it from registration. */
    readonly owner?: ProvisionedLeaseOwner;
    /** The host owes the owner a first turn on this box. */
    readonly firstTurnPending?: boolean;
    readonly now?: Date;
  }) => Promise<ProvisionedLease>;
  readonly claim: (input: {
    readonly leaseId: string;
    readonly owner: ProvisionedLeaseOwner;
    readonly now?: Date;
  }) => Promise<ProvisionedLease | null>;
  /** A client's heartbeat ends a run of unwatched moves; the host keeping a busy box awake does not. */
  readonly touch: (
    leaseId: string,
    now?: Date,
    by?: "client" | "host",
  ) => Promise<ProvisionedLease | null>;
  /**
   * Records how a pending first turn ended. A failed one also drops the owner: that chat may
   * never exist, and the page that sends the message itself claims the box again.
   */
  readonly settleFirstTurn: (
    leaseId: string,
    outcome: Exclude<FirstTurnState, { status: "pending" }>,
    now?: Date,
  ) => Promise<void>;
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
  /**
   * Records a lease's box removed, once its provider put it to sleep. A lease already removed
   * keeps its first removal time. Null for a missing or disposed lease.
   */
  readonly markRemoved: (leaseId: string, now?: Date) => Promise<ProvisionedLease | null>;
  /** Puts a removed lease back to paused until its grace ends; null after, or when not removed. */
  readonly restore: (leaseId: string, now?: Date) => Promise<ProvisionedLease | null>;
  /** Removed leases past their grace, whose boxes upkeep deletes for good. */
  readonly purgeable: (now?: Date) => Promise<ReadonlyArray<ProvisionedLease>>;
  readonly markActive: (input: {
    readonly leaseId: string;
    readonly namespaceResource?: NamespaceResource;
    readonly namespaceProxy?: { readonly proxyId: string; readonly proxyOrigin: string };
    readonly remoteAccess?: RemoteAccess;
    /** Upkeep moved the chat to a new Mac with no client asking; any other wake is a client's. */
    readonly hostMove?: boolean;
    readonly now?: Date;
  }) => Promise<ProvisionedLease | null>;
  readonly expired: (now?: Date) => Promise<ReadonlyArray<ProvisionedLease>>;
  /** Leases whose machine is running, paused and released ones excluded. */
  readonly awake: () => Promise<ReadonlyArray<ProvisionedLease>>;
  readonly paused: () => Promise<ReadonlyArray<ProvisionedLease>>;
  /**
   * Records a box moved from one account to another, and the limit that moved it. Limits already
   * past are dropped. Null when the lease is unknown.
   */
  readonly recordAccountSwitch: (
    leaseId: string,
    input: { readonly from: string; readonly to: string; readonly limit?: AccountLimit },
    now?: Date,
  ) => Promise<ProvisionedLease | null>;
  /** Records a limit a switch could not move away from, so the run is handled once. */
  readonly recordAccountLimit: (
    leaseId: string,
    limit: AccountLimit,
    now?: Date,
  ) => Promise<ProvisionedLease | null>;
  /** Null when the lease is unknown. */
  readonly setKeep: (leaseId: string, keep: LeaseKeep | null) => Promise<ProvisionedLease | null>;
  readonly recordBackup: (leaseId: string, backup: LeaseBackup) => Promise<void>;
  readonly recordRebuild: (leaseId: string, rebuild: LeaseRebuild) => Promise<void>;
  /** Null clears it. */
  readonly recordReboot: (leaseId: string, reboot: LeaseReboot | null) => Promise<void>;
  /** Null clears it. */
  readonly recordDiskPause: (leaseId: string, diskPause: LeaseDiskPause | null) => Promise<void>;
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
  const updateAccounts = (
    leaseId: string,
    now: Date | undefined,
    change: (lease: ProvisionedLease) => {
      readonly accounts?: ReadonlyArray<string>;
      readonly limit?: AccountLimit;
    },
  ) =>
    mutate((leases) => {
      const current = leases.find((lease) => lease.leaseId === leaseId);
      if (!current) return { leases, value: null };
      const { accounts, limit } = change(current);
      const at = nowIso(now);
      const limits = [
        ...(current.accountLimits ?? []).filter(
          (entry) => entry.until > at && entry.runId !== limit?.runId,
        ),
        ...(limit ? [limit] : []),
      ];
      const updated: ProvisionedLease = {
        ...current,
        ...(accounts ? { accounts } : {}),
        accountLimits: limits,
        updatedAt: at,
      };
      return {
        leases: leases.map((lease) => (lease.leaseId === leaseId ? updated : lease)),
        value: updated,
      };
    });

  return {
    register: (input) =>
      mutate((leases) => {
        const existing = leases.find((lease) => lease.leaseId === input.leaseId);
        if (existing) {
          // A provisioned lease learns its proxy from the attach that opened
          // it, after registration, so a re-registration without one is not
          // a conflict.
          if (
            existing.sandboxId !== input.sandboxId ||
            existing.retentionDeadline !== input.retentionDeadline ||
            existing.providerInstanceId !== input.providerInstanceId ||
            existing.provider !== input.provider ||
            (input.namespaceProxy &&
              (existing.namespaceProxy?.proxyId !== input.namespaceProxy.proxyId ||
                existing.namespaceProxy?.proxyOrigin !== input.namespaceProxy.proxyOrigin))
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
          ...(input.companionInstanceIds === undefined
            ? {}
            : { companionInstanceIds: input.companionInstanceIds }),
          state: "active",
          owner: input.owner ?? null,
          ...(input.firstTurnPending ? { firstTurn: { status: "pending" as const } } : {}),
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
    touch: (leaseId, now, by = "client") =>
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
        const { unwatchedMoves: _moves, ...rest } = current;
        const updated: ProvisionedLease = {
          ...(by === "host" ? current : rest),
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
    settleFirstTurn: (leaseId, outcome, now) =>
      mutate((leases) => ({
        leases: leases.map((lease) =>
          lease.leaseId !== leaseId || lease.firstTurn?.status !== "pending"
            ? lease
            : {
                ...lease,
                firstTurn: outcome,
                ...(outcome.status === "failed" ? { owner: null } : {}),
                updatedAt: nowIso(now),
              },
        ),
        value: undefined,
      })),
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
        leases: leases.map((lease) => {
          if (lease.leaseId !== leaseId) return lease;
          const { removedAt: _removedAt, ...rest } = lease;
          return { ...rest, state: "disposed" as const, updatedAt: nowIso(now) };
        }),
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
    markRemoved: (leaseId, now) =>
      mutate((leases) => {
        const current = leases.find((lease) => lease.leaseId === leaseId);
        if (current?.state === "removed") return { leases, value: current };
        if (
          !current ||
          (current.state !== "active" &&
            current.state !== "paused" &&
            current.state !== "releasing")
        )
          return { leases, value: null };
        const updated: ProvisionedLease = {
          ...current,
          state: "removed",
          removedAt: nowIso(now),
          updatedAt: nowIso(now),
        };
        return {
          leases: leases.map((lease) => (lease.leaseId === leaseId ? updated : lease)),
          value: updated,
        };
      }),
    restore: (leaseId, now) =>
      mutate((leases) => {
        const current = leases.find((lease) => lease.leaseId === leaseId);
        const until = current ? restorableUntil(current) : null;
        if (!current || until === null || until <= nowIso(now)) return { leases, value: null };
        const { removedAt: _removedAt, ...rest } = current;
        const updated: ProvisionedLease = { ...rest, state: "paused", updatedAt: nowIso(now) };
        return {
          leases: leases.map((lease) => (lease.leaseId === leaseId ? updated : lease)),
          value: updated,
        };
      }),
    purgeable: (now) =>
      consistentRead((leases) =>
        leases.filter((lease) => {
          const until = restorableUntil(lease);
          return until !== null && until <= nowIso(now);
        }),
      ),
    markActive: (input) =>
      mutate((leases) => {
        const current = leases.find((lease) => lease.leaseId === input.leaseId);
        if (!current || (current.state !== "active" && current.state !== "paused"))
          return { leases, value: null };
        // A proxy origin is recorded once, by the attach that opened it, and
        // never replaced: the paired client keeps connecting to that origin.
        if (
          (input.namespaceResource &&
            input.namespaceResource.devboxId !== current.namespaceResource?.devboxId) ||
          (input.namespaceProxy &&
            current.namespaceProxy &&
            (input.namespaceProxy.proxyId !== current.namespaceProxy.proxyId ||
              input.namespaceProxy.proxyOrigin !== current.namespaceProxy.proxyOrigin))
        )
          throw new Error("Provisioned lease identity conflict");
        const now = input.now ?? new Date();
        const { keep, unwatchedMoves, ...rest } = current;
        const updated: ProvisionedLease = {
          ...rest,
          ...(keep === "user" ? { keep } : {}),
          ...(input.hostMove ? { unwatchedMoves: (unwatchedMoves ?? 0) + 1 } : {}),
          ...(input.namespaceResource ? { namespaceResource: input.namespaceResource } : {}),
          ...(input.namespaceProxy ? { namespaceProxy: input.namespaceProxy } : {}),
          ...(input.remoteAccess ? { remoteAccess: input.remoteAccess } : {}),
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
    awake: () => consistentRead((leases) => leases.filter((lease) => lease.state === "active")),
    paused: () => consistentRead((leases) => leases.filter((lease) => lease.state === "paused")),
    recordAccountSwitch: (leaseId, input, now) =>
      updateAccounts(leaseId, now, (lease) => ({
        accounts: leaseAccounts(lease).map((id) => (id === input.from ? input.to : id)),
        ...(input.limit ? { limit: input.limit } : {}),
      })),
    recordAccountLimit: (leaseId, limit, now) => updateAccounts(leaseId, now, () => ({ limit })),
    setKeep: (leaseId, keep) =>
      mutate((leases) => {
        const current = leases.find((lease) => lease.leaseId === leaseId);
        if (!current) return { leases, value: null };
        const { keep: _previous, ...rest } = current;
        const updated: ProvisionedLease = keep === null ? rest : { ...rest, keep };
        return {
          leases: leases.map((lease) => (lease.leaseId === leaseId ? updated : lease)),
          value: updated,
        };
      }),
    recordBackup: (leaseId, backup) =>
      mutate((leases) => ({
        leases: leases.map((lease) => (lease.leaseId === leaseId ? { ...lease, backup } : lease)),
        value: undefined,
      })),
    recordReboot: (leaseId, reboot) =>
      mutate((leases) => ({
        leases: leases.map((lease) => {
          if (lease.leaseId !== leaseId) return lease;
          const { reboot: _previous, ...rest } = lease;
          return reboot === null ? rest : { ...rest, reboot };
        }),
        value: undefined,
      })),
    recordDiskPause: (leaseId, diskPause) =>
      mutate((leases) => ({
        leases: leases.map((lease) => {
          if (lease.leaseId !== leaseId) return lease;
          const { diskPause: _previous, ...rest } = lease;
          return diskPause === null ? rest : { ...rest, diskPause };
        }),
        value: undefined,
      })),
    recordRebuild: (leaseId, rebuild) =>
      mutate((leases) => ({
        leases: leases.map((lease) => (lease.leaseId === leaseId ? { ...lease, rebuild } : lease)),
        value: undefined,
      })),
  };
}
