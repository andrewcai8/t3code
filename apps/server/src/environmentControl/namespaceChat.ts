import * as Schema from "effect/Schema";
import { InstanceId, MacIncarnation, type Departure } from "./namespaceInstances.ts";

/**
 * A Namespace Mac chat's durable home: one finalized artifact. `final` was taken
 * after the guest fenced the root for release; `live` is a periodic save.
 */
export const ChatSnapshot = Schema.Struct({
  /** Saves count from 1. A save settles only onto the generation it was planned from. */
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Unique per save: a refused save expires its own path, which must not be the recorded one. */
  artifactPath: Schema.String,
  sha256: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Content hash the guest compares to skip uploading an unchanged root. */
  fingerprint: Schema.String,
  mode: Schema.Literals(["live", "final"]),
  fromInstance: InstanceId,
  savedAt: Schema.Finite,
});
export type ChatSnapshot = typeof ChatSnapshot.Type;

/**
 * What the live Mac may do to the repository's shared cache volume. Only a Mac
 * that started a new chat on a miss or stale template fills it, and only a
 * filler that sealed a pristine template may commit.
 */
export const MacCache = Schema.Literals(["unknown", "reader", "filling", "sealed"]);
export type MacCache = typeof MacCache.Type;

export const LiveMac = Schema.Struct({ incarnation: MacIncarnation, cache: MacCache });
export type LiveMac = typeof LiveMac.Type;

/** Keyed by chat id in the store. A missing record reads as idle with no snapshot. */
export const ChatRecord = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle"), snapshot: Schema.NullOr(ChatSnapshot) }),
  Schema.Struct({
    kind: Schema.Literal("live"),
    snapshot: Schema.NullOr(ChatSnapshot),
    mac: LiveMac,
  }),
]);
export type ChatRecord = typeof ChatRecord.Type;
type LiveRecord = Extract<ChatRecord, { kind: "live" }>;

export type ChatGoal = "open" | "release" | "dispose";
/** What the guest found on the cache volume when it adopted the template. */
export type Adoption = "hit" | "stale" | "miss";

/** Observed just before each plan. */
export interface ChatFacts {
  /** Live instances labelled for this chat. */
  readonly instances: ReadonlyArray<InstanceId>;
  /** Live artifact paths labelled for this chat. */
  readonly artifacts: ReadonlyArray<string>;
  readonly now: number;
}

export interface SaveStep {
  readonly kind: "save";
  readonly instanceId: InstanceId;
  readonly mode: ChatSnapshot["mode"];
  /** Set only when the recorded snapshot came from this instance, so the guest may answer `unchanged`. */
  readonly previousFingerprint: string | null;
  readonly generation: number;
}
export type ChatStep =
  | { readonly kind: "write"; readonly record: ChatRecord | null }
  | { readonly kind: "create" }
  /** `commit` means the performer scrubs the chat root, then destroys. */
  | { readonly kind: "depart"; readonly instanceId: InstanceId; readonly departure: Departure }
  | {
      readonly kind: "materialize";
      readonly instanceId: InstanceId;
      readonly snapshot: ChatSnapshot | null;
    }
  | { readonly kind: "seal"; readonly instanceId: InstanceId }
  | SaveStep
  | { readonly kind: "expire"; readonly paths: ReadonlyArray<string> };
type StepOf<K extends ChatStep["kind"]> = Extract<ChatStep, { kind: K }>;

export type SaveOutcome =
  | ({ readonly kind: "saved" } & Pick<
      ChatSnapshot,
      "artifactPath" | "sha256" | "bytes" | "fingerprint" | "savedAt"
    >)
  | { readonly kind: "unchanged" };

/** Carries out the effectful steps. Every handler must tolerate a rerun after a crash. */
export interface ChatPerformer {
  readonly create: () => Promise<MacIncarnation>;
  readonly depart: (step: StepOf<"depart">) => Promise<void>;
  /** Adopt the template, restore the snapshot and prepare, idempotently on the guest. */
  readonly materialize: (step: StepOf<"materialize">) => Promise<{ readonly adoption: Adoption }>;
  /** `sealed: false` gives up on filling the cache; it never fails the open. */
  readonly seal: (step: StepOf<"seal">) => Promise<{ readonly sealed: boolean }>;
  readonly save: (step: SaveStep) => Promise<SaveOutcome>;
  readonly expire: (step: StepOf<"expire">) => Promise<void>;
}

/** A step together with what performing it returned. */
export type Performed =
  | StepOf<"write">
  | StepOf<"depart">
  | StepOf<"expire">
  | (StepOf<"create"> & { readonly outcome: MacIncarnation })
  | (StepOf<"materialize"> & { readonly outcome: { readonly adoption: Adoption } })
  | (StepOf<"seal"> & { readonly outcome: { readonly sealed: boolean } })
  | (SaveStep & { readonly outcome: SaveOutcome });

/** `garbage` names artifacts nothing references any more, to expire best effort. */
export type Settled =
  | {
      readonly ok: true;
      readonly record: ChatRecord | null;
      readonly garbage: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: "stale"; readonly garbage: ReadonlyArray<string> };

export interface ChatStore {
  readonly read: (chatId: string) => Promise<ChatRecord | null>;
  /** Serialized per chat; `settle` sees the freshest record, and a stale result writes nothing. */
  readonly update: (
    chatId: string,
    settle: (current: ChatRecord | null) => Settled,
  ) => Promise<Settled>;
}

export interface ChatPorts {
  readonly chatId: string;
  readonly store: ChatStore;
  readonly facts: () => Promise<ChatFacts>;
  readonly perform: ChatPerformer;
}

/** Inside this much of the deadline a failing release stops saving and abandons the Mac. */
const SAVE_GIVE_UP_MS = 2 * 60_000;
const MAX_STEPS = 32;

const generationOf = (record: ChatRecord | null) => record?.snapshot?.generation ?? 0;

export const departureFor = (cache: MacCache): Departure =>
  cache === "sealed" ? "commit" : "abandon";

/** A Mac that restored a snapshot carries chat state, so it may never fill the cache. */
export const cacheRole = (adoption: Adoption, snapshot: ChatSnapshot | null): MacCache =>
  adoption !== "hit" && snapshot === null ? "filling" : "reader";

const currentOf = (record: LiveRecord) => record.mac.incarnation.instanceId;
const isCurrent = (record: ChatRecord | null, instanceId: InstanceId): record is LiveRecord =>
  record?.kind === "live" && currentOf(record) === instanceId;
const hasFinal = (record: LiveRecord) =>
  record.snapshot?.mode === "final" && record.snapshot.fromInstance === currentOf(record);

const saveStep = (record: LiveRecord, mode: SaveStep["mode"]): SaveStep => ({
  kind: "save",
  instanceId: currentOf(record),
  mode,
  previousFingerprint:
    record.snapshot?.fromInstance === currentOf(record) ? record.snapshot.fingerprint : null,
  generation: generationOf(record) + 1,
});

export function plan(
  record: ChatRecord | null,
  goal: ChatGoal,
  facts: ChatFacts,
): ChatStep | { readonly kind: "done" } {
  const current = record?.kind === "live" ? currentOf(record) : null;
  // The Mac died out of band: everything since the last save is gone with it.
  if (record?.kind === "live" && !facts.instances.includes(currentOf(record)))
    return { kind: "write", record: { kind: "idle", snapshot: record.snapshot } };
  const stray = facts.instances.find((instanceId) => instanceId !== current);
  if (stray !== undefined) return { kind: "depart", instanceId: stray, departure: "abandon" };
  return record?.kind === "live"
    ? planLive(record, goal, facts.now)
    : planIdle(record, goal, facts.artifacts);
}

function planLive(record: LiveRecord, goal: ChatGoal, now: number): ChatStep | { kind: "done" } {
  const instanceId = currentOf(record);
  const cache = record.mac.cache;
  switch (goal) {
    case "open":
      // A release that stopped after its final save left a fenced Mac whose later work
      // that snapshot would hide. Finish the release, then open on a new Mac.
      if (hasFinal(record)) return { kind: "depart", instanceId, departure: departureFor(cache) };
      switch (cache) {
        case "unknown":
          return { kind: "materialize", instanceId, snapshot: record.snapshot };
        case "filling":
          return { kind: "seal", instanceId };
        case "reader":
        case "sealed":
          return { kind: "done" };
        default:
          return cache satisfies never;
      }
    case "release":
      // No turn runs before materialize is recorded, so there is nothing to save.
      if (cache === "unknown") return { kind: "depart", instanceId, departure: "abandon" };
      if (hasFinal(record)) return { kind: "depart", instanceId, departure: departureFor(cache) };
      if (record.mac.incarnation.deadline - now < SAVE_GIVE_UP_MS)
        return { kind: "depart", instanceId, departure: "abandon" };
      return saveStep(record, "final");
    case "dispose":
      return { kind: "depart", instanceId, departure: "abandon" };
    default:
      return goal satisfies never;
  }
}

function planIdle(
  record: ChatRecord | null,
  goal: ChatGoal,
  artifacts: ReadonlyArray<string>,
): ChatStep | { kind: "done" } {
  const kept = record?.snapshot?.artifactPath ?? null;
  switch (goal) {
    case "open":
      return { kind: "create" };
    case "release": {
      // Saves interrupted before they were recorded leave artifacts nothing references.
      const orphans = artifacts.filter((path) => path !== kept);
      return orphans.length > 0 ? { kind: "expire", paths: orphans } : { kind: "done" };
    }
    case "dispose": {
      const paths = [...new Set([...artifacts, ...(kept === null ? [] : [kept])])];
      if (paths.length > 0) return { kind: "expire", paths };
      return record === null ? { kind: "done" } : { kind: "write", record: null };
    }
    default:
      return goal satisfies never;
  }
}

/** Saves are compare-and-swap on the generation, so an older save never overwrites a newer one. */
export function planPeriodicSave(record: ChatRecord | null, facts: ChatFacts): SaveStep | null {
  if (
    record?.kind !== "live" ||
    !facts.instances.includes(currentOf(record)) ||
    record.mac.cache === "unknown" ||
    hasFinal(record)
  )
    return null;
  return saveStep(record, "live");
}

const ok = (record: ChatRecord | null, garbage: ReadonlyArray<string> = []): Settled => ({
  ok: true,
  record,
  garbage,
});
const withCache = (record: LiveRecord, cache: MacCache): ChatRecord => ({
  ...record,
  mac: { ...record.mac, cache },
});

/** Pure. Run it against the freshest record, inside the store's serialized update. */
export function settle(record: ChatRecord | null, done: Performed): Settled {
  switch (done.kind) {
    case "write":
      return ok(done.record);
    case "create":
      return ok({
        kind: "live",
        snapshot: record?.snapshot ?? null,
        mac: { incarnation: done.outcome, cache: "unknown" },
      });
    case "depart":
      return ok(
        isCurrent(record, done.instanceId) ? { kind: "idle", snapshot: record.snapshot } : record,
      );
    case "materialize":
      return ok(
        isCurrent(record, done.instanceId)
          ? withCache(record, cacheRole(done.outcome.adoption, done.snapshot))
          : record,
      );
    case "seal":
      return ok(
        isCurrent(record, done.instanceId)
          ? withCache(record, done.outcome.sealed ? "sealed" : "reader")
          : record,
      );
    case "save":
      return settleSave(record, done);
    case "expire":
      return ok(
        record?.snapshot && done.paths.includes(record.snapshot.artifactPath)
          ? { ...record, snapshot: null }
          : record,
      );
    default:
      return done satisfies never;
  }
}

function settleSave(record: ChatRecord | null, done: SaveStep & { outcome: SaveOutcome }): Settled {
  const { outcome } = done;
  const stale: Settled = {
    ok: false,
    reason: "stale",
    garbage: outcome.kind === "saved" ? [outcome.artifactPath] : [],
  };
  if (!isCurrent(record, done.instanceId) || generationOf(record) !== done.generation - 1)
    return stale;
  const previous = record.snapshot;
  if (outcome.kind === "saved") {
    const { kind: _, ...saved } = outcome;
    return ok(
      {
        ...record,
        snapshot: {
          ...saved,
          generation: done.generation,
          mode: done.mode,
          fromInstance: done.instanceId,
        },
      },
      previous === null ? [] : [previous.artifactPath],
    );
  }
  if (done.mode === "live") return ok(record);
  // `unchanged` compared against this instance's own snapshot, which now stands as the final one.
  if (previous === null || previous.fromInstance !== done.instanceId) return stale;
  return ok({ ...record, snapshot: { ...previous, mode: "final" } });
}

async function perform(
  step: Exclude<ChatStep, { kind: "write" }>,
  performer: ChatPerformer,
): Promise<Performed> {
  switch (step.kind) {
    case "create":
      return { ...step, outcome: await performer.create() };
    case "depart":
      await performer.depart(step);
      return step;
    case "materialize":
      return { ...step, outcome: await performer.materialize(step) };
    case "seal":
      return { ...step, outcome: await performer.seal(step) };
    case "save":
      return { ...step, outcome: await performer.save(step) };
    case "expire":
      await performer.expire(step);
      return step;
    default:
      return step satisfies never;
  }
}

async function expireGarbage(paths: ReadonlyArray<string>, performer: ChatPerformer) {
  // Best effort: release and dispose sweep whatever this misses.
  if (paths.length > 0) await performer.expire({ kind: "expire", paths }).catch(() => undefined);
}

/** Drives the chat to `goal` from wherever a previous, possibly crashed, run left it. */
export async function drive(goal: ChatGoal, ports: ChatPorts): Promise<ChatRecord | null> {
  for (let step = 0; step < MAX_STEPS; step++) {
    const record = await ports.store.read(ports.chatId);
    const next = plan(record, goal, await ports.facts());
    if (next.kind === "done") return record;
    const done = next.kind === "write" ? next : await perform(next, ports.perform);
    const settled = await ports.store.update(ports.chatId, (current) => settle(current, done));
    await expireGarbage(settled.garbage, ports.perform);
  }
  throw new Error(`Namespace chat ${ports.chatId} did not converge on ${goal}.`);
}

export async function periodicSave(
  ports: ChatPorts,
): Promise<"saved" | "unchanged" | "stale" | "skipped"> {
  const step = planPeriodicSave(await ports.store.read(ports.chatId), await ports.facts());
  if (step === null) return "skipped";
  const outcome = await ports.perform.save(step);
  const settled = await ports.store.update(ports.chatId, (current) =>
    settle(current, { ...step, outcome }),
  );
  await expireGarbage(settled.garbage, ports.perform);
  return settled.ok ? outcome.kind : "stale";
}
