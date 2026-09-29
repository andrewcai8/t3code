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
import * as Schema from "effect/Schema";
import { canonicalRepository } from "./config.ts";
import { GitRevision, provisionDigest, Sha256, writeReplace } from "./ProvisionPreparation.ts";

/**
 * Per repository, an E2B snapshot of a box that already cloned the repository
 * and ran its prepare commands. A new chat for the repository starts from it
 * and only fetches its own revision and reruns the (now incremental) prepare
 * commands. The upkeep loop is the only writer; chat freezes only read.
 */
export const WarmBaseSeed = Schema.Struct({
  providerInstanceId: EnvironmentProvisionInput.fields.providerInstanceId,
  agentDriver: EnvironmentProvisionInput.fields.agentDriver,
});
export type WarmBaseSeed = typeof WarmBaseSeed.Type;
export const WarmBaseRecord = Schema.Struct({
  /** Canonical `owner/name`. */
  repository: Schema.String,
  /** Routing hint a rebuild freezes with: the last chat's account and driver. */
  seed: WarmBaseSeed,
  ready: Schema.NullOr(
    Schema.Struct({
      key: Sha256,
      snapshotId: Schema.String,
      templateId: Schema.String,
      sourceRevision: GitRevision,
      builtAt: IsoDateTime,
    }),
  ),
  build: Schema.NullOr(
    Schema.Struct({ key: Sha256, requestId: ProvisionRequestId, startedAt: IsoDateTime }),
  ),
  lastFailure: Schema.NullOr(
    Schema.Struct({ key: Sha256, reason: Schema.String, at: IsoDateTime }),
  ),
  /** Things to dispose once the provider lets us: replaced snapshots and finished build boxes. */
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

export interface WarmBasePolicy {
  /** A base this old is rebuilt. */
  readonly refreshMs: number;
  /** A base this old is no longer handed to chats, rebuilt or not. */
  readonly maxAgeMs: number;
  readonly buildDeadlineMs: number;
  readonly failureBackoffMs: number;
  /** How long a replaced snapshot stays for chats that froze it but are not yet created. */
  readonly retireGraceMs: number;
}
export function warmBasePolicy(refreshHours = 12): WarmBasePolicy {
  const refreshMs = refreshHours * HOUR;
  return {
    refreshMs,
    maxAgeMs: 2 * refreshMs,
    buildDeadlineMs: 90 * MINUTE,
    failureBackoffMs: HOUR,
    retireGraceMs: HOUR,
  };
}

const age = (iso: string, now: number) => now - Date.parse(iso);
const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** The bare template a chat keyed `key` starts from, or null to start cold. */
export function selectWarmTemplate(
  record: WarmBaseRecord | null,
  key: string,
  now: number,
  policy: WarmBasePolicy,
): string | null {
  const ready = record?.ready;
  return ready && ready.key === key && age(ready.builtAt, now) <= policy.maxAgeMs
    ? ready.templateId
    : null;
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
  const ready = record?.ready ?? null;
  const needed =
    ready === null
      ? wanted || record !== null
      : ready.key !== currentKey || age(ready.builtAt, now) >= policy.refreshMs;
  if (!needed) return "idle";
  const failure = record?.lastFailure;
  return failure && failure.key === currentKey && age(failure.at, now) < policy.failureBackoffMs
    ? "idle"
    : "start";
}

type Retired = WarmBaseRecord["retired"][number];
const retiredBuild = (record: WarmBaseRecord, now: number): Retired[] =>
  record.build ? [{ kind: "build", requestId: record.build.requestId, retiredAt: iso(now) }] : [];
const retiredReady = (record: WarmBaseRecord, now: number): Retired[] =>
  record.ready
    ? [{ kind: "snapshot", snapshotId: record.ready.snapshotId, retiredAt: iso(now) }]
    : [];

/** The repository keeps no warm base any more: everything it had is disposed. */
const retireAll = (record: WarmBaseRecord, now: number): WarmBaseRecord => ({
  ...record,
  ready: null,
  build: null,
  retired: [...record.retired, ...retiredReady(record, now), ...retiredBuild(record, now)],
});
const abandonBuild = (record: WarmBaseRecord, reason: string, now: number): WarmBaseRecord => ({
  ...record,
  build: null,
  lastFailure: record.build ? { key: record.build.key, reason, at: iso(now) } : record.lastFailure,
  retired: [...record.retired, ...retiredBuild(record, now)],
});
const promoteBuild = (
  record: WarmBaseRecord,
  ready: NonNullable<WarmBaseRecord["ready"]>,
  now: number,
): WarmBaseRecord => ({
  ...record,
  ready,
  build: null,
  lastFailure: null,
  retired: [...record.retired, ...retiredReady(record, now), ...retiredBuild(record, now)],
});

export function makeWarmBaseStore(stateDir: string) {
  const directory = NodePath.join(stateDir, "provisioning", "warm-bases");
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
  readonly seal: (operation: ProvisionOperation) => Promise<void>;
  readonly snapshot: (
    operation: ProvisionOperation,
  ) => Promise<{ readonly snapshotId: string; readonly templateId: string }>;
  readonly deleteSnapshot: (snapshotId: string) => Promise<"deleted" | "missing" | "in_use">;
  readonly warn: (message: string, context: Record<string, unknown>) => void;
}

/**
 * Keeps each repository's warm base current. `want` records that a chat for a
 * repository started cold; `tick` builds, replaces, and disposes bases.
 */
export function makeWarmBaseUpkeep(ports: WarmBasePorts) {
  const wanted = new Map<string, WarmBaseSeed>();

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
        const snapshot = await ports.snapshot(operation);
        const builtAt = ports.now();
        return promoteBuild(
          record,
          { key: build.key, ...snapshot, sourceRevision, builtAt: iso(builtAt) },
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
    for (const item of record.retired) {
      try {
        if (item.kind === "build") {
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
    return { ...record, retired: kept };
  };

  const upkeep = async (
    repository: string,
    stored: WarmBaseRecord | null,
    policy: WarmBasePolicy,
  ) => {
    const want = wanted.get(repository);
    const seed = want ?? stored?.seed;
    const key = await ports.key(repository);
    const now = ports.now();
    const step = nextWarmStep(stored, key, want !== undefined, now, policy);
    if (!seed || (stored === null && step === "idle")) {
      wanted.delete(repository);
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
      ...stored,
      seed,
    };
    if (key === null) record = retireAll(record, now);
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
        record = { ...record, lastFailure: { key, reason: frozen.reason, at: iso(now) } };
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
    if (wanted.get(repository) === want) wanted.delete(repository);
  };

  return {
    want: (repository: string, seed: WarmBaseSeed) => {
      wanted.set(canonicalRepository(repository), seed);
    },
    tick: async (policy: WarmBasePolicy) => {
      const records = new Map(
        (await ports.store.list()).map((record) => [record.repository, record]),
      );
      for (const repository of new Set([...records.keys(), ...wanted.keys()]))
        await upkeep(repository, records.get(repository) ?? null, policy).catch((cause) =>
          ports.warn("warm base upkeep failed", { repository, cause }),
        );
    },
  };
}
