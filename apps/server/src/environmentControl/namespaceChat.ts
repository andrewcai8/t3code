import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { InstanceId, MacIncarnation } from "./namespaceInstances.ts";

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
 * Whether a live Mac holds the chat yet: `unknown` until its materialize is recorded. A chat's
 * Mac only ever reads the cache volume; a builder Mac with no chat fills it.
 */
export const MacStage = Schema.Literals(["unknown", "ready"]);
export type MacStage = typeof MacStage.Type;
/**
 * Stored as `cache`, which records written when a chat's Mac could fill the cache named by its
 * role. Those roles all mean ready, and ready is written back as `reader`, which they understand.
 */
const StoredStage = Schema.Literals(["unknown", "reader", "filling", "sealed"]).pipe(
  Schema.decodeTo(
    MacStage,
    SchemaTransformation.transform({
      decode: (stored): MacStage => (stored === "unknown" ? "unknown" : "ready"),
      encode: (stage) => (stage === "ready" ? "reader" : "unknown"),
    }),
  ),
);

export const LiveMac = Schema.Struct({ incarnation: MacIncarnation, cache: StoredStage });
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
  /** The Mac died out of band. Settles only a record still live on that Mac. */
  | { readonly kind: "lost"; readonly instanceId: InstanceId }
  /** Dispose's last step. Never removes a record that is live again. */
  | { readonly kind: "forget" }
  | { readonly kind: "create" }
  /** Halts, then destroys: a chat's Mac never commits the cache volume. */
  | { readonly kind: "depart"; readonly instanceId: InstanceId }
  | {
      readonly kind: "materialize";
      readonly instanceId: InstanceId;
      readonly snapshot: ChatSnapshot | null;
    }
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
  readonly materialize: (step: StepOf<"materialize">) => Promise<void>;
  readonly save: (step: SaveStep) => Promise<SaveOutcome>;
  readonly expire: (step: StepOf<"expire">) => Promise<void>;
}

/** A step together with what performing it returned. */
export type Performed =
  | StepOf<"lost">
  | StepOf<"forget">
  | StepOf<"depart">
  | StepOf<"expire">
  | StepOf<"materialize">
  | (StepOf<"create"> & { readonly outcome: MacIncarnation })
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
    return { kind: "lost", instanceId: currentOf(record) };
  const stray = facts.instances.find((instanceId) => instanceId !== current);
  if (stray !== undefined) return { kind: "depart", instanceId: stray };
  return record?.kind === "live"
    ? planLive(record, goal, facts.now)
    : planIdle(record, goal, facts.artifacts);
}

function planLive(record: LiveRecord, goal: ChatGoal, now: number): ChatStep | { kind: "done" } {
  const instanceId = currentOf(record);
  const ready = record.mac.cache === "ready";
  switch (goal) {
    case "open":
      // A release that stopped after its final save left a fenced Mac whose later work
      // that snapshot would hide. Finish the release, then open on a new Mac.
      if (hasFinal(record)) return { kind: "depart", instanceId };
      return ready
        ? { kind: "done" }
        : { kind: "materialize", instanceId, snapshot: record.snapshot };
    case "release":
      // No turn runs before materialize is recorded, so there is nothing to save.
      if (!ready || hasFinal(record)) return { kind: "depart", instanceId };
      if (record.mac.incarnation.deadline - now < SAVE_GIVE_UP_MS)
        return { kind: "depart", instanceId };
      return saveStep(record, "final");
    case "dispose":
      return { kind: "depart", instanceId };
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
      return record === null ? { kind: "done" } : { kind: "forget" };
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

/** Pure. Run it against the freshest record, inside the store's serialized update. */
export function settle(record: ChatRecord | null, done: Performed): Settled {
  switch (done.kind) {
    case "lost":
      // Against the record as it is now: a release or resume since the caller looked wins.
      return ok(
        isCurrent(record, done.instanceId) ? { kind: "idle", snapshot: record.snapshot } : record,
      );
    case "forget":
      return ok(record?.kind === "live" ? record : null);
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
          ? { ...record, mac: { ...record.mac, cache: "ready" } }
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
  step: Exclude<ChatStep, { kind: "lost" | "forget" }>,
  performer: ChatPerformer,
): Promise<Performed> {
  switch (step.kind) {
    case "create":
      return { ...step, outcome: await performer.create() };
    case "depart":
      await performer.depart(step);
      return step;
    case "materialize":
      await performer.materialize(step);
      return step;
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
    const done =
      next.kind === "lost" || next.kind === "forget" ? next : await perform(next, ports.perform);
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
