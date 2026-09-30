// @effect-diagnostics nodeBuiltinImport:off - warm base records live in the manager's private state directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  EnvironmentProvisionInput,
  IsoDateTime,
  ProvisionRequestId,
  type ProvisionOperation,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { canonicalRepository } from "./config.ts";
import {
  GitRevision,
  provisionDigest,
  Sha256,
  writeOnce,
  writeReplace,
} from "./ProvisionPreparation.ts";

/**
 * Per repository, a box that already cloned the repository and ran its prepare
 * commands, kept for new chats to start from. A chat only fetches its own
 * revision and reruns the (now incremental) prepare commands.
 *
 * On E2B the base is a snapshot, which outlives the box it was taken from and
 * starts any number of chats. On Namespace, which cannot snapshot a Mac, it is
 * a spare: the build's own stopped Devbox, which exactly one chat claims.
 *
 * The upkeep loop is the only writer of a record. Chat freezes only read it,
 * and a chat takes a spare through `makeSpareClaims`.
 */
export const WarmBaseSeed = Schema.Struct({
  providerInstanceId: EnvironmentProvisionInput.fields.providerInstanceId,
  agentDriver: EnvironmentProvisionInput.fields.agentDriver,
});
export type WarmBaseSeed = typeof WarmBaseSeed.Type;
const builtFields = { key: Sha256, sourceRevision: GitRevision, builtAt: IsoDateTime };
export const WarmBaseRecord = Schema.Struct({
  /** Canonical `owner/name`. */
  repository: Schema.String,
  /** Routing hint a rebuild freezes with: the last chat's account and driver. */
  seed: WarmBaseSeed,
  ready: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ ...builtFields, snapshotId: Schema.String, templateId: Schema.String }),
      /** A spare, named by the build request whose Devbox it is. */
      Schema.Struct({ ...builtFields, requestId: ProvisionRequestId }),
    ]),
  ),
  build: Schema.NullOr(
    Schema.Struct({ key: Sha256, requestId: ProvisionRequestId, startedAt: IsoDateTime }),
  ),
  lastFailure: Schema.NullOr(
    Schema.Struct({
      key: Sha256,
      reason: Schema.String,
      at: IsoDateTime,
      /** Consecutive failures for `key`. Records from before it was counted read as one. */
      attempts: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
    }),
  ),
  /**
   * When a chat last wanted a base or started from one. Absent on records from
   * before it was tracked, which count their base's build as the last use.
   */
  lastUsedAt: Schema.optional(IsoDateTime),
  /**
   * Things to dispose once the provider lets us: replaced snapshots, finished
   * build boxes, and spares no chat may claim any more.
   */
  retired: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("snapshot"),
        snapshotId: Schema.String,
        retiredAt: IsoDateTime,
      }),
      Schema.Struct({
        kind: Schema.Literal("build"),
        requestId: ProvisionRequestId,
        retiredAt: IsoDateTime,
      }),
    ]),
  ),
});
export type WarmBaseRecord = typeof WarmBaseRecord.Type;
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(WarmBaseRecord));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A build box outlives its deadline by long enough to be sealed and snapshotted. */
const BUILD_RETENTION_MS = 2 * HOUR;
const MAX_FAILURE_BACKOFF_MS = 24 * HOUR;

export interface WarmBasePolicy {
  /** A base this old is rebuilt. */
  readonly refreshMs: number;
  /** A base this old is no longer handed to chats, rebuilt or not. */
  readonly maxAgeMs: number;
  readonly buildDeadlineMs: number;
  readonly failureBackoffMs: number;
  /** How long a replaced snapshot stays for chats that froze it but are not yet created. */
  readonly retireGraceMs: number;
  /** A repository no chat used for this long keeps no base. */
  readonly idleMs: number;
}
export function warmBasePolicy(refreshHours = 12): WarmBasePolicy {
  const refreshMs = refreshHours * HOUR;
  return {
    refreshMs,
    maxAgeMs: 2 * refreshMs,
    buildDeadlineMs: 90 * MINUTE,
    failureBackoffMs: HOUR,
    retireGraceMs: HOUR,
    idleMs: 3 * 24 * HOUR,
  };
}

const age = (iso: string, now: number) => now - Date.parse(iso);
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
const lastUse = (record: WarmBaseRecord) => record.lastUsedAt ?? record.ready?.builtAt;
/** No chat used the repository for so long that keeping a base costs more than it saves. */
const idleExpired = (
  record: WarmBaseRecord | null,
  wanted: boolean,
  now: number,
  policy: WarmBasePolicy,
) => {
  const used = record ? lastUse(record) : undefined;
  return !wanted && used !== undefined && age(used, now) > policy.idleMs;
};

type Ready = NonNullable<WarmBaseRecord["ready"]>;
/** The base a chat keyed `key` may start from. */
const servable = (
  record: WarmBaseRecord | null,
  key: string,
  now: number,
  policy: WarmBasePolicy,
): Ready | null => {
  const ready = record?.ready;
  return ready && ready.key === key && age(ready.builtAt, now) <= policy.maxAgeMs ? ready : null;
};

/**
 * The bare template a chat keyed `key` starts from, or null to start cold.
 * `failedTemplates` are bases a chat already failed to prepare from.
 */
export function selectWarmTemplate(
  record: WarmBaseRecord | null,
  key: string,
  now: number,
  policy: WarmBasePolicy,
  failedTemplates: ReadonlySet<string> = new Set(),
): string | null {
  const ready = servable(record, key, now, policy);
  return ready && "templateId" in ready && !failedTemplates.has(ready.templateId)
    ? ready.templateId
    : null;
}

/**
 * The spare a chat keyed `key` may try to claim, by its build request, or null
 * to start cold. `failedKeys` are keys a chat already failed to prepare a spare of.
 */
export function selectSpare(
  record: WarmBaseRecord | null,
  key: string,
  now: number,
  policy: WarmBasePolicy,
  failedKeys: ReadonlySet<string> = new Set(),
): ProvisionRequestId | null {
  const ready = servable(record, key, now, policy);
  return ready && "requestId" in ready && !failedKeys.has(key) ? ready.requestId : null;
}

/**
 * What the upkeep does for a repository this tick. `currentKey` is null when
 * the repository no longer keeps a warm base, and `wanted` when a chat started
 * cold since the last tick.
 */
export function nextWarmStep(
  record: WarmBaseRecord | null,
  currentKey: string | null,
  wanted: boolean,
  now: number,
  policy: WarmBasePolicy,
): "idle" | "start" | "drive" {
  if (currentKey === null) return "idle";
  if (record?.build) return "drive";
  if (idleExpired(record, wanted, now, policy)) return "idle";
  const ready = record?.ready ?? null;
  const needed =
    ready === null
      ? wanted || record !== null
      : ready.key !== currentKey || age(ready.builtAt, now) >= policy.refreshMs;
  if (!needed) return "idle";
  const last = record?.lastFailure;
  return last &&
    last.key === currentKey &&
    age(last.at, now) <
      Math.min(policy.failureBackoffMs * 2 ** (last.attempts - 1), MAX_FAILURE_BACKOFF_MS)
    ? "idle"
    : "start";
}

type Retired = WarmBaseRecord["retired"][number];
const retiredBuild = (record: WarmBaseRecord, now: number): Retired[] =>
  record.build ? [{ kind: "build", requestId: record.build.requestId, retiredAt: iso(now) }] : [];
/** What holds a base on the provider: its snapshot, or for a spare its build's box. */
const retiredReady = (record: WarmBaseRecord, now: number): Retired[] => {
  const ready = record.ready;
  if (!ready) return [];
  return "snapshotId" in ready
    ? [{ kind: "snapshot", snapshotId: ready.snapshotId, retiredAt: iso(now) }]
    : [{ kind: "build", requestId: ready.requestId, retiredAt: iso(now) }];
};
/** A spare left the pool: a chat claimed it, or nothing may claim it any more. */
const retireReady = (record: WarmBaseRecord, now: number): WarmBaseRecord => ({
  ...record,
  ready: null,
  retired: [...record.retired, ...retiredReady(record, now)],
});

/** The repository keeps no warm base any more: everything it had is disposed. */
const retireAll = (record: WarmBaseRecord, now: number): WarmBaseRecord => ({
  ...record,
  ready: null,
  build: null,
  retired: [...record.retired, ...retiredReady(record, now), ...retiredBuild(record, now)],
});
/** Another failure for `key`: consecutive ones for the same key back off longer. */
const failure = (record: WarmBaseRecord, key: string, reason: string, now: number) => ({
  key,
  reason,
  at: iso(now),
  attempts: record.lastFailure?.key === key ? record.lastFailure.attempts + 1 : 1,
});
/** A chat failed to prepare from the base, so no chat starts from it again. */
const invalidateReady = (record: WarmBaseRecord, reason: string, now: number): WarmBaseRecord =>
  record.ready
    ? {
        ...record,
        ready: null,
        lastFailure: failure(record, record.ready.key, reason, now),
        retired: [...record.retired, ...retiredReady(record, now)],
      }
    : record;
/** Nobody uses the base, so it is disposed; the last use stays so it stays idle. */
const retireIdle = (record: WarmBaseRecord, now: number): WarmBaseRecord =>
  record.ready
    ? {
        ...record,
        ready: null,
        lastUsedAt: record.lastUsedAt ?? record.ready.builtAt,
        retired: [...record.retired, ...retiredReady(record, now)],
      }
    : record;
/**
 * A chat failed to prepare on a spare keyed `key`. The spare that failed is that
 * chat's by now, and another built from the same inputs would fail the same
 * way, so none serves or is being built until the backoff has passed.
 */
const condemnKey = (
  record: WarmBaseRecord,
  key: string,
  reason: string,
  now: number,
): WarmBaseRecord => {
  const ready = record.ready?.key === key;
  const build = record.build?.key === key;
  // Already waiting out this failure: the chat's retries are not new ones.
  if (!ready && !build && record.lastFailure?.key === key) return record;
  return {
    ...record,
    ready: ready ? null : record.ready,
    build: build ? null : record.build,
    lastFailure: failure(record, key, reason, now),
    retired: [
      ...record.retired,
      ...(ready ? retiredReady(record, now) : []),
      ...(build ? retiredBuild(record, now) : []),
    ],
  };
};
const abandonBuild = (record: WarmBaseRecord, reason: string, now: number): WarmBaseRecord => ({
  ...record,
  build: null,
  lastFailure: record.build ? failure(record, record.build.key, reason, now) : record.lastFailure,
  retired: [...record.retired, ...retiredBuild(record, now)],
});
/** A snapshot outlives its build's box, which is disposed. A spare is that box. */
const promoteBuild = (record: WarmBaseRecord, ready: Ready, now: number): WarmBaseRecord => ({
  ...record,
  ready,
  build: null,
  lastFailure: null,
  retired: [
    ...record.retired,
    ...retiredReady(record, now),
    ...("requestId" in ready ? [] : retiredBuild(record, now)),
  ],
});

export function makeWarmBaseStore(stateDir: string, kind: "warm-bases" | "spares" = "warm-bases") {
  const directory = NodePath.join(stateDir, "provisioning", kind);
  const path = (repository: string) =>
    NodePath.join(directory, `${provisionDigest(canonicalRepository(repository))}.json`);
  const readPath = async (file: string) => {
    try {
      return decodeRecord(await NodeFSP.readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    read: (repository: string) => readPath(path(repository)),
    list: async (): Promise<WarmBaseRecord[]> => {
      const names = await NodeFSP.readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const records: WarmBaseRecord[] = [];
      for (const name of names.filter((entry) => entry.endsWith(".json"))) {
        const record = await readPath(NodePath.join(directory, name));
        if (record) records.push(record);
      }
      return records;
    },
    write: async (record: WarmBaseRecord) => {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeReplace(path(record.repository), stableStringify(record));
    },
  };
}
export type WarmBaseStore = ReturnType<typeof makeWarmBaseStore>;

const SpareClaim = Schema.Struct({ by: Schema.String, at: IsoDateTime });
const decodeClaim = Schema.decodeUnknownSync(Schema.fromJsonString(SpareClaim));
/** The claimant the upkeep uses to take a spare out of the pool before disposing it. */
export const SPARE_RETIRED = "retired";

/**
 * Who has each spare, one file per spare. A chat's freeze and the upkeep both
 * want a spare at once (one to start on it, one to dispose it), and whichever
 * creates the file owns the Devbox. Separate from the record so that neither
 * ever overwrites the other's decision.
 */
export function makeSpareClaims(stateDir: string) {
  const directory = NodePath.join(stateDir, "provisioning", "spares", "claims");
  const path = (spare: ProvisionRequestId) => NodePath.join(directory, `${spare}.json`);
  const holder = async (spare: ProvisionRequestId) => {
    try {
      return decodeClaim(await NodeFSP.readFile(path(spare), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const claim = (by: string, now: number) => stableStringify({ by, at: iso(now) });
  return {
    holder,
    /** Takes the spare for `by`. Only the first taker succeeds, and it may ask again. */
    take: async (spare: ProvisionRequestId, by: string, now: number) => {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeOnce(path(spare), (temporary) =>
        NodeFSP.writeFile(temporary, claim(by, now), { flag: "wx", mode: 0o600 }),
      );
      return (await holder(spare))?.by === by;
    },
    /** Hands a claim whose claimant never came back to another. Only the upkeep calls this. */
    reassign: (spare: ProvisionRequestId, by: string, now: number) =>
      writeReplace(path(spare), claim(by, now)),
  };
}
export type SpareClaims = ReturnType<typeof makeSpareClaims>;

/** How long a claim waits for its chat's freeze to finish before the spare counts as abandoned. */
const CLAIM_GRACE_MS = 10 * MINUTE;

/**
 * Settles whose a retired spare's Devbox is. True when it is the upkeep's to
 * dispose: nobody claimed it, or the chat that did never froze a request for
 * it. False once a chat's request runs on it, and then the build that made it
 * is released, so that only the chat's request can dispose the Devbox.
 */
export async function settleSpare(
  claims: SpareClaims,
  spare: ProvisionRequestId,
  now: number,
  chats: {
    /** Whether the chat `requestId` names froze a request. */
    readonly frozen: (requestId: string) => Promise<boolean>;
    /** Ends the spare's build without disposing its Devbox. */
    readonly release: (spare: ProvisionRequestId) => Promise<void>;
  },
): Promise<boolean> {
  if (await claims.take(spare, SPARE_RETIRED, now)) return true;
  const holder = await claims.holder(spare);
  if (!holder) throw new Error("The spare's claim disappeared.");
  if (await chats.frozen(holder.by)) {
    await chats.release(spare);
    return false;
  }
  if (age(holder.at, now) < CLAIM_GRACE_MS) throw new Error("A chat is still claiming the spare.");
  await claims.reassign(spare, SPARE_RETIRED, now);
  return true;
}

export interface WarmBasePorts {
  readonly store: Pick<WarmBaseStore, "list" | "write">;
  readonly now: () => number;
  /** `warmBaseKey` for the repository under the current configuration. */
  readonly key: (repository: string) => Promise<string | null>;
  /**
   * Freezes a cold build of the repository's default branch through the same
   * path chats take, and returns the warm key it froze.
   */
  readonly freezeBuild: (input: {
    readonly requestId: ProvisionRequestId;
    readonly repository: string;
    readonly seed: WarmBaseSeed;
    readonly retentionDeadline: string;
  }) => Promise<string | undefined>;
  /** Drives the build's provision operation as far as it goes now. Re-entrant. */
  readonly ensure: (requestId: ProvisionRequestId) => Promise<ProvisionOperation>;
  readonly cancel: (requestId: ProvisionRequestId) => Promise<ProvisionOperation>;
  /** Snapshots taken from the build's box, which outlive the box. */
  readonly buildSnapshots: (requestId: ProvisionRequestId) => Promise<ReadonlyArray<string>>;
  readonly seal: (operation: ProvisionOperation) => Promise<void>;
  /** What a sealed build becomes for chats: a snapshot of it, or the box itself as a spare. */
  readonly capture: (
    operation: ProvisionOperation,
  ) => Promise<
    | { readonly snapshotId: string; readonly templateId: string }
    | { readonly requestId: ProvisionRequestId }
  >;
  readonly deleteSnapshot: (snapshotId: string) => Promise<"deleted" | "missing" | "in_use">;
  /** Whether anyone has taken this spare. Absent where chats share a base. */
  readonly taken?: (requestId: ProvisionRequestId) => Promise<boolean>;
  /**
   * Whether a retired build's box is the upkeep's to dispose. False once a
   * chat owns it, and then the build is released instead. Absent where no
   * chat ever owns a build's box.
   */
  readonly owns?: (requestId: ProvisionRequestId) => Promise<boolean>;
  readonly warn: (message: string, context: Record<string, unknown>) => void;
}

/**
 * Keeps each repository's warm base current. `want` records that a chat for a
 * repository started cold; `tick` builds, replaces, and disposes bases.
 */
export function makeWarmBaseUpkeep(ports: WarmBasePorts) {
  const wanted = new Map<string, WarmBaseSeed>();
  /** When a chat last wanted or started from each repository's base, until a tick records it. */
  const uses = new Map<string, number>();
  /**
   * Bases a chat failed to prepare from, until a tick retires them: a snapshot
   * by its template, a spare by its key.
   */
  const failures = new Map<string, { readonly repository: string; readonly reason: string }>();

  const drive = async (
    record: WarmBaseRecord,
    build: NonNullable<WarmBaseRecord["build"]>,
    key: string,
    now: number,
    policy: WarmBasePolicy,
  ): Promise<WarmBaseRecord> => {
    if (build.key !== key)
      return abandonBuild(record, "The repository's warm base inputs changed.", now);
    if (age(build.startedAt, now) > policy.buildDeadlineMs)
      return abandonBuild(record, "The warm base build did not finish in time.", now);
    const operation = await ports.ensure(build.requestId);
    const state = operation.state;
    switch (state.kind) {
      case "ready": {
        const sourceRevision = state.readiness.sourceRevision;
        if (!sourceRevision)
          return abandonBuild(record, "The warm base build has no repository revision.", now);
        await ports.seal(operation);
        const captured = await ports.capture(operation);
        const builtAt = ports.now();
        return promoteBuild(
          record,
          { key: build.key, ...captured, sourceRevision, builtAt: iso(builtAt) },
          builtAt,
        );
      }
      case "failed":
        return abandonBuild(record, state.reason, now);
      case "cancel_requested":
      case "disposed":
        return abandonBuild(record, "The warm base build was cancelled.", now);
      default:
        return record;
    }
  };

  const dispose = async (record: WarmBaseRecord, now: number, policy: WarmBasePolicy) => {
    const kept: Retired[] = [];
    const orphans: Retired[] = [];
    const known = new Set([
      record.ready && "snapshotId" in record.ready ? record.ready.snapshotId : undefined,
      ...record.retired.map((item) => (item.kind === "snapshot" ? item.snapshotId : undefined)),
    ]);
    for (const item of record.retired) {
      try {
        if (item.kind === "build") {
          // E2B keeps a snapshot after its source box is gone, so one taken
          // just before the manager lost track of its build is found now.
          for (const snapshotId of await ports.buildSnapshots(item.requestId))
            if (!known.has(snapshotId)) {
              known.add(snapshotId);
              orphans.push({ kind: "snapshot", snapshotId, retiredAt: iso(now) });
            }
          if (ports.owns && !(await ports.owns(item.requestId))) continue;
          if ((await ports.cancel(item.requestId)).state.kind === "disposed") continue;
        } else if (
          age(item.retiredAt, now) >= policy.retireGraceMs &&
          (await ports.deleteSnapshot(item.snapshotId)) !== "in_use"
        )
          continue;
      } catch (cause) {
        ports.warn("a retired warm base could not be disposed yet", {
          repository: record.repository,
          cause,
        });
      }
      kept.push(item);
    }
    return { ...record, retired: [...kept, ...orphans] };
  };

  const upkeep = async (
    repository: string,
    stored: WarmBaseRecord | null,
    policy: WarmBasePolicy,
  ) => {
    const want = wanted.get(repository);
    const usedAt = uses.get(repository);
    const reported = [...failures].filter(([, failure]) => failure.repository === repository);
    const settle = () => {
      if (wanted.get(repository) === want) wanted.delete(repository);
      if (uses.get(repository) === usedAt) uses.delete(repository);
      for (const [templateId, failure] of reported)
        if (failures.get(templateId) === failure) failures.delete(templateId);
    };
    const seed = want ?? stored?.seed;
    const key = await ports.key(repository);
    const now = ports.now();
    const broken =
      stored?.ready && "templateId" in stored.ready && failures.get(stored.ready.templateId);
    const condemned = key === null ? undefined : failures.get(key);
    const invalidated =
      stored && broken
        ? invalidateReady(stored, broken.reason, now)
        : stored && condemned && key !== null
          ? condemnKey(stored, key, condemned.reason, now)
          : stored;
    // A spare someone took is no longer in the pool. Disposal settles whose it is.
    const pooled =
      invalidated?.ready &&
      "requestId" in invalidated.ready &&
      (await ports.taken?.(invalidated.ready.requestId))
        ? retireReady(invalidated, now)
        : invalidated;
    const current =
      pooled && usedAt !== undefined ? { ...pooled, lastUsedAt: iso(usedAt) } : pooled;
    const step = nextWarmStep(current, key, want !== undefined, now, policy);
    if (!seed || (current === null && step === "idle")) {
      settle();
      return;
    }
    let saved = stored;
    const save = async (next: WarmBaseRecord) => {
      await ports.store.write(next);
      saved = next;
    };
    let record: WarmBaseRecord = {
      repository,
      ready: null,
      build: null,
      lastFailure: null,
      retired: [],
      ...current,
      ...(usedAt === undefined ? {} : { lastUsedAt: iso(usedAt) }),
      seed,
    };
    if (key === null) record = retireAll(record, now);
    else if (idleExpired(record, want !== undefined, now, policy)) record = retireIdle(record, now);
    if (step === "start" && key !== null) {
      const requestId = ProvisionRequestId.make(NodeCrypto.randomUUID());
      const frozen = await ports
        .freezeBuild({
          requestId,
          repository,
          seed,
          retentionDeadline: iso(now + BUILD_RETENTION_MS),
        })
        .then(
          (warmKey) =>
            warmKey
              ? ({ warmKey } as const)
              : ({ reason: "The repository no longer keeps a warm base." } as const),
          (cause: unknown) => ({
            reason: cause instanceof Error ? cause.message : "The build could not be frozen.",
          }),
        );
      if ("reason" in frozen)
        record = { ...record, lastFailure: failure(record, key, frozen.reason, now) };
      else {
        // Recorded before the build is driven, so a crash mid-build still
        // finds and disposes it.
        record = { ...record, build: { key: frozen.warmKey, requestId, startedAt: iso(now) } };
        await save(record);
      }
    }
    if (record.build && key !== null) record = await drive(record, record.build, key, now, policy);
    record = await dispose(record, now, policy);
    if (stableStringify(record) !== stableStringify(saved)) await save(record);
    settle();
  };

  return {
    /** A chat failed to prepare from the snapshot template, or on a spare with the key, `base`. */
    failed: (repository: string, base: string, reason: string) => {
      failures.set(base, { repository: canonicalRepository(repository), reason });
    },
    failedBases: (): ReadonlySet<string> => new Set(failures.keys()),
    want: (repository: string, seed: WarmBaseSeed) => {
      wanted.set(canonicalRepository(repository), seed);
      uses.set(canonicalRepository(repository), ports.now());
    },
    /** A chat started from the repository's warm base. */
    used: (repository: string) => {
      uses.set(canonicalRepository(repository), ports.now());
    },
    tick: async (policy: WarmBasePolicy) => {
      const records = new Map(
        (await ports.store.list()).map((record) => [record.repository, record]),
      );
      const reported = [...failures.values()].map(({ repository }) => repository);
      for (const repository of new Set([
        ...records.keys(),
        ...wanted.keys(),
        ...uses.keys(),
        ...reported,
      ]))
        await upkeep(repository, records.get(repository) ?? null, policy).catch((cause) =>
          ports.warn("warm base upkeep failed", { repository, cause }),
        );
    },
  };
}
