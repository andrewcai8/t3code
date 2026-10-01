import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  type ChatFacts,
  type ChatGoal,
  type ChatPerformer,
  type ChatPorts,
  type ChatRecord,
  type ChatSnapshot,
  type ChatStep,
  type ChatStore,
  drive,
  LiveMac,
  type MacStage,
  type Performed,
  periodicSave,
  plan,
  planPeriodicSave,
  type SaveStep,
  settle,
} from "./namespaceChat.ts";
import { InstanceId, type MacIncarnation } from "./namespaceInstances.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
const FAR = NOW + 4 * HOUR;
const NEAR = NOW + 60_000;
const MAC_A = InstanceId.make("mac-a");
const MAC_B = InstanceId.make("mac-b");
const STRAY = InstanceId.make("mac-stray");
const ORPHAN = "t3/chats/chat-1/orphan";

const snap = (
  generation: number,
  mode: ChatSnapshot["mode"],
  fromInstance: InstanceId,
): ChatSnapshot => ({
  generation,
  artifactPath: `t3/chats/chat-1/${generation}`,
  sha256: `sha-${generation}`,
  bytes: 100,
  fingerprint: `fp-${generation}`,
  mode,
  fromInstance,
  savedAt: NOW - HOUR,
});
const incarnation = (instanceId: InstanceId, deadline = FAR): MacIncarnation => ({
  instanceId,
  site: "iad4",
  createdAt: NOW - HOUR,
  deadline,
});
const liveOn = (
  cache: MacStage,
  snapshot: ChatSnapshot | null,
  deadline = FAR,
  instanceId = MAC_A,
): ChatRecord => ({
  kind: "live",
  snapshot,
  mac: { incarnation: incarnation(instanceId, deadline), cache },
});
const idle = (snapshot: ChatSnapshot | null): ChatRecord => ({ kind: "idle", snapshot });
const seen = (instances: ReadonlyArray<InstanceId>, artifacts: ReadonlyArray<string> = []) => ({
  instances,
  artifacts,
  now: NOW,
});

describe("plan", () => {
  it.each<{
    name: string;
    record: ChatRecord | null;
    goal: ChatGoal;
    facts: ChatFacts;
    expected: ChatStep | { kind: "done" };
  }>([
    {
      name: "open: a Mac that died out of band leaves the chat idle on its last snapshot",
      record: liveOn("ready", snap(1, "live", MAC_A)),
      goal: "open",
      facts: seen([]),
      expected: { kind: "lost", instanceId: MAC_A },
    },
    {
      name: "release: a dead Mac is recorded idle before any stray is handled",
      record: liveOn("ready", snap(2, "final", MAC_A)),
      goal: "release",
      facts: seen([STRAY]),
      expected: { kind: "lost", instanceId: MAC_A },
    },
    {
      name: "dispose: a dead Mac that never materialized leaves no snapshot",
      record: liveOn("unknown", null),
      goal: "dispose",
      facts: seen([]),
      expected: { kind: "lost", instanceId: MAC_A },
    },
    {
      name: "open: a stray from a crashed create is abandoned first",
      record: null,
      goal: "open",
      facts: seen([STRAY]),
      expected: { kind: "depart", instanceId: STRAY },
    },
    {
      name: "release: a stray beside a Mac is abandoned first",
      record: liveOn("ready", snap(2, "final", MAC_A)),
      goal: "release",
      facts: seen([MAC_A, STRAY]),
      expected: { kind: "depart", instanceId: STRAY },
    },
    {
      name: "open: a new chat creates a Mac",
      record: null,
      goal: "open",
      facts: seen([]),
      expected: { kind: "create" },
    },
    {
      name: "open: a released chat creates a Mac",
      record: idle(snap(3, "final", MAC_B)),
      goal: "open",
      facts: seen([], ["t3/chats/chat-1/3"]),
      expected: { kind: "create" },
    },
    {
      name: "open: a fresh Mac materializes the recorded snapshot",
      record: liveOn("unknown", snap(3, "final", MAC_B)),
      goal: "open",
      facts: seen([MAC_A]),
      expected: { kind: "materialize", instanceId: MAC_A, snapshot: snap(3, "final", MAC_B) },
    },
    {
      name: "open: a materialized Mac is ready",
      record: liveOn("ready", null),
      goal: "open",
      facts: seen([MAC_A]),
      expected: { kind: "done" },
    },
    {
      name: "open: a release that stopped after its final save is finished first",
      record: liveOn("ready", snap(2, "final", MAC_A)),
      goal: "open",
      facts: seen([MAC_A]),
      expected: { kind: "depart", instanceId: MAC_A },
    },
    {
      name: "release: a chat that never started is already released",
      record: null,
      goal: "release",
      facts: seen([]),
      expected: { kind: "done" },
    },
    {
      name: "release: an idle chat holding only its snapshot is released",
      record: idle(snap(3, "final", MAC_A)),
      goal: "release",
      facts: seen([], ["t3/chats/chat-1/3"]),
      expected: { kind: "done" },
    },
    {
      name: "release: an idle chat expires saves that were never recorded",
      record: idle(snap(3, "final", MAC_A)),
      goal: "release",
      facts: seen([], ["t3/chats/chat-1/3", ORPHAN]),
      expected: { kind: "expire", paths: [ORPHAN] },
    },
    {
      name: "release: a Mac that never materialized is abandoned without a save",
      record: liveOn("unknown", snap(3, "final", MAC_B)),
      goal: "release",
      facts: seen([MAC_A]),
      expected: { kind: "depart", instanceId: MAC_A },
    },
    {
      name: "release: a Mac with its own final snapshot departs",
      record: liveOn("ready", snap(4, "final", MAC_A)),
      goal: "release",
      facts: seen([MAC_A]),
      expected: { kind: "depart", instanceId: MAC_A },
    },
    {
      name: "release: inside the give-up window the Mac abandons on its last periodic save",
      record: liveOn("ready", snap(2, "live", MAC_A), NEAR),
      goal: "release",
      facts: seen([MAC_A]),
      expected: { kind: "depart", instanceId: MAC_A },
    },
    {
      name: "release: a final save offers the Mac's own fingerprint",
      record: liveOn("ready", snap(2, "live", MAC_A)),
      goal: "release",
      facts: seen([MAC_A]),
      expected: {
        kind: "save",
        instanceId: MAC_A,
        mode: "final",
        previousFingerprint: "fp-2",
        generation: 3,
      },
    },
    {
      name: "release: a snapshot restored from another Mac is never treated as unchanged",
      record: liveOn("ready", snap(2, "final", MAC_B)),
      goal: "release",
      facts: seen([MAC_A]),
      expected: {
        kind: "save",
        instanceId: MAC_A,
        mode: "final",
        previousFingerprint: null,
        generation: 3,
      },
    },
    {
      name: "release: a chat with no snapshot saves generation 1",
      record: liveOn("ready", null),
      goal: "release",
      facts: seen([MAC_A]),
      expected: {
        kind: "save",
        instanceId: MAC_A,
        mode: "final",
        previousFingerprint: null,
        generation: 1,
      },
    },
    {
      name: "dispose: a live Mac departs without a save",
      record: liveOn("ready", snap(4, "final", MAC_A)),
      goal: "dispose",
      facts: seen([MAC_A]),
      expected: { kind: "depart", instanceId: MAC_A },
    },
    {
      name: "dispose: an idle chat expires its snapshot and every labelled artifact",
      record: idle(snap(3, "final", MAC_A)),
      goal: "dispose",
      facts: seen([], [ORPHAN]),
      expected: { kind: "expire", paths: [ORPHAN, "t3/chats/chat-1/3"] },
    },
    {
      name: "dispose: an idle chat with nothing left deletes its record",
      record: idle(null),
      goal: "dispose",
      facts: seen([]),
      expected: { kind: "forget" },
    },
    {
      name: "dispose: an unknown chat with nothing left is disposed",
      record: null,
      goal: "dispose",
      facts: seen([]),
      expected: { kind: "done" },
    },
    {
      name: "dispose: an unknown chat still expires labelled artifacts",
      record: null,
      goal: "dispose",
      facts: seen([], [ORPHAN]),
      expected: { kind: "expire", paths: [ORPHAN] },
    },
  ])("$name", ({ record, goal, facts, expected }) => {
    expect(plan(record, goal, facts)).toEqual(expected);
  });

  it("keeps the save invariants across every record, goal and observation", () => {
    const snapshots = {
      none: null,
      ownLive: snap(2, "live", MAC_A),
      ownFinal: snap(2, "final", MAC_A),
      otherFinal: snap(2, "final", MAC_B),
    };
    const caches: ReadonlyArray<MacStage> = ["unknown", "ready"];
    const goals: ReadonlyArray<ChatGoal> = ["open", "release", "dispose"];
    const cases: Array<{
      label: string;
      record: ChatRecord | null;
      alive: boolean;
      nearDeadline: boolean;
      ownFinal: boolean;
    }> = [{ label: "none", record: null, alive: false, nearDeadline: false, ownFinal: false }];
    for (const [kind, snapshot] of Object.entries(snapshots)) {
      cases.push({
        label: `idle/${kind}`,
        record: idle(snapshot),
        alive: false,
        nearDeadline: false,
        ownFinal: false,
      });
      for (const cache of caches)
        for (const alive of [true, false])
          for (const nearDeadline of [true, false])
            cases.push({
              label: `live/${cache}/${kind}/${alive ? "alive" : "gone"}/${nearDeadline ? "near" : "far"}`,
              record: liveOn(cache, snapshot, nearDeadline ? NEAR : FAR),
              alive,
              nearDeadline,
              ownFinal: kind === "ownFinal",
            });
    }

    const broken: string[] = [];
    const kinds = new Set<string>();
    for (const { label, record, alive, nearDeadline, ownFinal } of cases)
      for (const strays of [false, true])
        for (const goal of goals) {
          const facts = seen(
            [...(alive ? [MAC_A] : []), ...(strays ? [STRAY] : [])],
            [ORPHAN, "t3/chats/chat-1/2"],
          );
          const step = plan(record, goal, facts);
          kinds.add(step.kind);
          const where = `${goal} ${label}${strays ? " +stray" : ""} -> ${JSON.stringify(step)}`;
          const live = record?.kind === "live" ? record : null;
          const cache = live?.mac.cache ?? null;
          const departsCurrent = step.kind === "depart" && step.instanceId === MAC_A;
          const finishesRelease = goal !== "dispose" && alive && !strays && ownFinal;
          if (finishesRelease && !departsCurrent)
            broken.push(`a Mac fenced by its own final save is reused: ${where}`);
          if (
            goal === "release" &&
            alive &&
            cache !== "unknown" &&
            !ownFinal &&
            !nearDeadline &&
            departsCurrent
          )
            broken.push(`release departs a Mac whose work is not saved: ${where}`);
          if (
            goal === "release" &&
            alive &&
            !strays &&
            cache !== "unknown" &&
            !ownFinal &&
            !nearDeadline &&
            !(step.kind === "save" && step.mode === "final")
          )
            broken.push(`release saves before departing: ${where}`);
          if (goal === "open" && (step.kind === "save" || (departsCurrent && !ownFinal)))
            broken.push(`open saves, or departs a Mac whose work is not saved: ${where}`);
          if (
            live &&
            !alive &&
            JSON.stringify(step) !== JSON.stringify({ kind: "lost", instanceId: MAC_A })
          )
            broken.push(`a dead Mac is not recorded idle on its snapshot: ${where}`);
        }

    expect(broken).toEqual([]);
    expect([...kinds].toSorted()).toEqual([
      "create",
      "depart",
      "done",
      "expire",
      "lost",
      "materialize",
      "save",
    ]);
  });
});

const decodeLiveMac = Schema.decodeUnknownSync(LiveMac);
const encodeLiveMac = Schema.encodeSync(LiveMac);

describe("a live Mac's stage as stored", () => {
  const stored = (cache: string) => ({ incarnation: incarnation(MAC_A), cache });
  it.each<[string, MacStage]>([
    ["unknown", "unknown"],
    ["reader", "ready"],
    ["filling", "ready"],
    ["sealed", "ready"],
  ])("reads %s, from a manager that let chats fill the cache, as %s", (cache, stage) => {
    expect(decodeLiveMac(stored(cache)).cache).toBe(stage);
  });

  it("writes ready as the reader role, which such a manager departs by abandoning", () => {
    expect(encodeLiveMac({ incarnation: incarnation(MAC_A), cache: "ready" })).toEqual(
      stored("reader"),
    );
  });
});

describe("planPeriodicSave", () => {
  it.each<{
    name: string;
    record: ChatRecord | null;
    instances: ReadonlyArray<InstanceId>;
    expected: SaveStep | null;
  }>([
    {
      name: "a ready Mac saves live over its own snapshot",
      record: liveOn("ready", snap(2, "live", MAC_A)),
      instances: [MAC_A],
      expected: {
        kind: "save",
        instanceId: MAC_A,
        mode: "live",
        previousFingerprint: "fp-2",
        generation: 3,
      },
    },
    {
      name: "a resumed Mac saves over the snapshot it restored",
      record: liveOn("ready", snap(1, "final", MAC_B)),
      instances: [MAC_A],
      expected: {
        kind: "save",
        instanceId: MAC_A,
        mode: "live",
        previousFingerprint: null,
        generation: 2,
      },
    },
    {
      name: "a Mac that never materialized is skipped",
      record: liveOn("unknown", null),
      instances: [MAC_A],
      expected: null,
    },
    {
      name: "a Mac fenced by its final save is skipped",
      record: liveOn("ready", snap(3, "final", MAC_A)),
      instances: [MAC_A],
      expected: null,
    },
    {
      name: "a dead Mac is skipped",
      record: liveOn("ready", snap(2, "live", MAC_A)),
      instances: [],
      expected: null,
    },
    {
      name: "an idle chat is skipped",
      record: idle(snap(2, "final", MAC_A)),
      instances: [],
      expected: null,
    },
  ])("$name", ({ record, instances, expected }) => {
    expect(planPeriodicSave(record, seen(instances))).toEqual(expected);
  });
});

describe("settling a lost Mac and a forgotten chat against the current record", () => {
  it.each<{
    name: string;
    record: ChatRecord | null;
    done: Performed;
    expected: ChatRecord | null;
  }>([
    {
      name: "the live record on the lost Mac goes idle on its current snapshot",
      record: liveOn("ready", snap(2, "live", MAC_A)),
      done: { kind: "lost", instanceId: MAC_A },
      expected: idle(snap(2, "live", MAC_A)),
    },
    {
      name: "a release that recorded a newer snapshot since is kept",
      record: idle(snap(3, "final", MAC_A)),
      done: { kind: "lost", instanceId: MAC_A },
      expected: idle(snap(3, "final", MAC_A)),
    },
    {
      name: "a resume onto another Mac since is kept",
      record: liveOn("ready", snap(2, "final", MAC_A), FAR, MAC_B),
      done: { kind: "lost", instanceId: MAC_A },
      expected: liveOn("ready", snap(2, "final", MAC_A), FAR, MAC_B),
    },
    {
      name: "dispose forgets an idle chat",
      record: idle(null),
      done: { kind: "forget" },
      expected: null,
    },
    {
      name: "dispose never forgets a chat that is live again",
      record: liveOn("ready", null),
      done: { kind: "forget" },
      expected: liveOn("ready", null),
    },
  ])("$name", ({ record, done, expected }) => {
    expect(settle(record, done)).toEqual({ ok: true, record: expected, garbage: [] });
  });
});

describe("settle", () => {
  const saved = (artifactPath: string, fingerprint: string) => ({
    kind: "saved" as const,
    artifactPath,
    sha256: "sha-new",
    bytes: 200,
    fingerprint,
    savedAt: NOW,
  });
  const save = (
    instanceId: InstanceId,
    mode: SaveStep["mode"],
    generation: number,
    outcome: ReturnType<typeof saved> | { kind: "unchanged" },
  ) => ({
    kind: "save" as const,
    instanceId,
    mode,
    previousFingerprint: null,
    generation,
    outcome,
  });

  it("records a created Mac as unmaterialized and keeps the snapshot", () => {
    expect(settle(null, { kind: "create", outcome: incarnation(MAC_A) })).toEqual({
      ok: true,
      record: liveOn("unknown", null),
      garbage: [],
    });
    expect(
      settle(idle(snap(2, "final", MAC_B)), { kind: "create", outcome: incarnation(MAC_A) }),
    ).toEqual({ ok: true, record: liveOn("unknown", snap(2, "final", MAC_B)), garbage: [] });
  });

  it("idles the chat when its own Mac departs and ignores a stray's departure", () => {
    const record = liveOn("ready", snap(2, "final", MAC_A));
    expect(settle(record, { kind: "depart", instanceId: MAC_A })).toEqual({
      ok: true,
      record: idle(snap(2, "final", MAC_A)),
      garbage: [],
    });
    expect(settle(record, { kind: "depart", instanceId: STRAY })).toEqual({
      ok: true,
      record,
      garbage: [],
    });
  });

  it("makes its own Mac ready once materialized, and ignores another's", () => {
    const fresh = liveOn("unknown", snap(1, "final", MAC_B));
    expect(
      settle(fresh, { kind: "materialize", instanceId: MAC_A, snapshot: snap(1, "final", MAC_B) }),
    ).toEqual({ ok: true, record: liveOn("ready", snap(1, "final", MAC_B)), garbage: [] });
    expect(settle(fresh, { kind: "materialize", instanceId: STRAY, snapshot: null })).toEqual({
      ok: true,
      record: fresh,
      garbage: [],
    });
  });

  it("records a new save and names the snapshot it replaced as garbage", () => {
    expect(
      settle(
        liveOn("ready", snap(2, "live", MAC_A)),
        save(MAC_A, "final", 3, saved("t3/chats/chat-1/new", "fp-new")),
      ),
    ).toEqual({
      ok: true,
      record: liveOn("ready", {
        generation: 3,
        artifactPath: "t3/chats/chat-1/new",
        sha256: "sha-new",
        bytes: 200,
        fingerprint: "fp-new",
        mode: "final",
        fromInstance: MAC_A,
        savedAt: NOW,
      }),
      garbage: ["t3/chats/chat-1/2"],
    });
  });

  it("promotes the Mac's own unchanged snapshot to final, and leaves it alone on a live save", () => {
    const record = liveOn("ready", snap(2, "live", MAC_A));
    expect(settle(record, save(MAC_A, "final", 3, { kind: "unchanged" }))).toEqual({
      ok: true,
      record: liveOn("ready", snap(2, "final", MAC_A)),
      garbage: [],
    });
    expect(settle(record, save(MAC_A, "live", 3, { kind: "unchanged" }))).toEqual({
      ok: true,
      record,
      garbage: [],
    });
  });

  it.each<{ name: string; record: ChatRecord | null; done: ReturnType<typeof save> }>([
    {
      name: "a live save planned at generation 1 after a final save recorded generation 2",
      record: liveOn("ready", snap(2, "final", MAC_A)),
      done: save(MAC_A, "live", 2, saved(ORPHAN, "fp-late")),
    },
    {
      name: "a late save from an old Mac after a new Mac took over at the same generation",
      record: liveOn("unknown", snap(1, "final", MAC_A), FAR, MAC_B),
      done: save(MAC_A, "live", 2, saved(ORPHAN, "fp-late")),
    },
    {
      name: "a save that lands after its Mac departed",
      record: idle(snap(1, "final", MAC_A)),
      done: save(MAC_A, "final", 2, saved(ORPHAN, "fp-late")),
    },
  ])("refuses $name and hands back its artifact", ({ record, done }) => {
    expect(settle(record, done)).toEqual({ ok: false, reason: "stale", garbage: [ORPHAN] });
  });

  it("refuses an unchanged final save with no snapshot of its own to promote", () => {
    expect(
      settle(
        liveOn("ready", snap(1, "final", MAC_B)),
        save(MAC_A, "final", 2, { kind: "unchanged" }),
      ),
    ).toEqual({ ok: false, reason: "stale", garbage: [] });
  });

  it("drops the snapshot only when its artifact is expired", () => {
    const record = idle(snap(3, "final", MAC_A));
    expect(settle(record, { kind: "expire", paths: [ORPHAN, "t3/chats/chat-1/3"] })).toEqual({
      ok: true,
      record: idle(null),
      garbage: [],
    });
    expect(settle(record, { kind: "expire", paths: [ORPHAN] })).toEqual({
      ok: true,
      record,
      garbage: [],
    });
  });
});

interface SimMac {
  readonly id: InstanceId;
  readonly chatId: string;
  root: { work: string; fenced: boolean } | null;
  fate: "alive" | "departed" | "killed";
}

/** Namespace and the guest, reduced to what the chat protocol can break. */
function makeWorld() {
  const macs = new Map<InstanceId, SimMac>();
  const artifacts = new Map<string, { chatId: string; work: string; live: boolean }>();
  const violations: string[] = [];
  let created = 0;
  let uploads = 0;
  const alive = (instanceId: InstanceId) => {
    const mac = macs.get(instanceId);
    if (mac?.fate !== "alive") throw new Error(`instance ${instanceId} is gone`);
    return mac;
  };
  const world = {
    macs,
    artifacts,
    violations,
    facts: (chatId: string): ChatFacts => ({
      instances: [...macs.values()]
        .filter((mac) => mac.chatId === chatId && mac.fate === "alive")
        .map((mac) => mac.id),
      artifacts: [...artifacts]
        .filter(([, artifact]) => artifact.chatId === chatId && artifact.live)
        .map(([path]) => path),
      now: NOW,
    }),
    create: (chatId: string): MacIncarnation => {
      const id = InstanceId.make(`mac-${++created}`);
      macs.set(id, { id, chatId, root: null, fate: "alive" });
      return { instanceId: id, site: "iad4", createdAt: NOW, deadline: NOW + 5 * HOUR };
    },
    materialize: (instanceId: InstanceId, snapshot: ChatSnapshot | null) => {
      const mac = alive(instanceId);
      if (mac.root !== null) return;
      let work = "";
      if (snapshot !== null) {
        const artifact = artifacts.get(snapshot.artifactPath);
        if (!artifact?.live) throw new Error(`snapshot ${snapshot.artifactPath} expired`);
        work = artifact.work;
      }
      mac.root = { work, fenced: false };
    },
    save: (step: SaveStep) => {
      const mac = alive(step.instanceId);
      const root = mac.root;
      if (root === null) {
        violations.push(`${step.instanceId} saved a scrubbed root`);
        throw new Error("no chat root");
      }
      if (step.mode === "live" && root.fenced) throw new Error("the guest is fenced for release");
      if (step.mode === "final") root.fenced = true;
      const fingerprint = `fp:${root.work}`;
      if (fingerprint === step.previousFingerprint) return { kind: "unchanged" as const };
      const artifactPath = `t3/chats/${mac.chatId}/${++uploads}`;
      artifacts.set(artifactPath, { chatId: mac.chatId, work: root.work, live: true });
      return {
        kind: "saved" as const,
        artifactPath,
        sha256: `sha-${uploads}`,
        bytes: root.work.length,
        fingerprint,
        savedAt: NOW,
      };
    },
    depart: (instanceId: InstanceId) => {
      const mac = macs.get(instanceId);
      if (mac?.fate === "alive") mac.fate = "departed";
    },
    kill: (instanceId: InstanceId) => {
      alive(instanceId).fate = "killed";
    },
    expire: (paths: ReadonlyArray<string>) => {
      for (const path of paths) {
        const artifact = artifacts.get(path);
        if (artifact) artifact.live = false;
      }
    },
    work: (instanceId: InstanceId, text: string) => {
      const mac = macs.get(instanceId);
      if (mac?.fate !== "alive" || mac.root === null || mac.root.fenced) return false;
      mac.root.work += text;
      return true;
    },
  };
  return world;
}
type World = ReturnType<typeof makeWorld>;

class ManagerCrash extends Error {}
interface CrashPoint {
  readonly at: number;
  readonly when: "before" | "after";
}

/** One chat's manager: an in-memory record store and a performer that can crash around any action. */
function makeChat(world: World, chatId = "chat-1") {
  const records = new Map<string, ChatRecord>();
  let crash: CrashPoint | null = null;
  let crashed = false;
  let actions = 0;
  const act = async <T>(run: () => T): Promise<T> => {
    const index = actions++;
    const inject = crash?.at === index && !crashed;
    if (inject && crash?.when === "before") {
      crashed = true;
      throw new ManagerCrash();
    }
    const result = run();
    if (inject && crash?.when === "after") {
      crashed = true;
      throw new ManagerCrash();
    }
    return result;
  };
  const store: ChatStore = {
    read: async (id) => records.get(id) ?? null,
    update: (id, settleRecord) =>
      act(() => {
        const settled = settleRecord(records.get(id) ?? null);
        if (settled.ok && settled.record === null) records.delete(id);
        if (settled.ok && settled.record !== null) records.set(id, settled.record);
        return settled;
      }),
  };
  const perform: ChatPerformer = {
    create: () => act(() => world.create(chatId)),
    depart: (step) => act(() => world.depart(step.instanceId)),
    materialize: (step) => act(() => world.materialize(step.instanceId, step.snapshot)),
    save: (step) => act(() => world.save(step)),
    expire: (step) => act(() => world.expire(step.paths)),
  };
  const ports: ChatPorts = { chatId, store, facts: async () => world.facts(chatId), perform };
  const record = () => records.get(chatId) ?? null;
  return {
    ports,
    record,
    /** Runs `goal` once, crashing at `at`. Reports how many actions it took and whether a crash fired. */
    run: async (goal: ChatGoal, at: CrashPoint | null = null) => {
      actions = 0;
      crash = at;
      crashed = false;
      try {
        await drive(goal, ports);
        return { actions, crashed, completed: true };
      } catch (error) {
        if (!(error instanceof ManagerCrash)) throw error;
        return { actions, crashed, completed: false };
      } finally {
        crash = null;
      }
    },
    turn: (text: string) => {
      const current = record();
      if (current?.kind !== "live" || current.mac.cache === "unknown") return false;
      return world.work(current.mac.incarnation.instanceId, text);
    },
    durableWork: () => {
      const snapshot = record()?.snapshot;
      return snapshot ? (world.artifacts.get(snapshot.artifactPath)?.work ?? "<expired>") : "";
    },
  };
}
type Chat = ReturnType<typeof makeChat>;

type Op =
  | { readonly op: "goal"; readonly goal: ChatGoal }
  | { readonly op: "turn"; readonly text: string }
  | { readonly op: "periodic" }
  | { readonly op: "kill" };

function endState(world: World, chat: Chat) {
  const record = chat.record();
  const facts = world.facts("chat-1");
  return {
    record:
      record === null
        ? null
        : {
            kind: record.kind,
            generation: record.snapshot?.generation ?? null,
            mode: record.snapshot?.mode ?? null,
            work: record.snapshot ? chat.durableWork() : null,
          },
    liveInstances: facts.instances.length,
    liveArtifacts: facts.artifacts.map((path) => world.artifacts.get(path)?.work).toSorted(),
    violations: [...world.violations],
  };
}

async function runScenario(
  ops: ReadonlyArray<Op>,
  crash: (CrashPoint & { readonly op: number }) | null = null,
) {
  const world = makeWorld();
  const chat = makeChat(world);
  const actionCounts = new Map<number, number>();
  let crashed = false;
  for (const [index, op] of ops.entries()) {
    switch (op.op) {
      case "goal": {
        const first = await chat.run(op.goal, crash?.op === index ? crash : null);
        actionCounts.set(index, first.actions);
        crashed ||= first.crashed;
        if (!first.completed) expect((await chat.run(op.goal)).completed).toBe(true);
        break;
      }
      case "turn":
        expect(chat.turn(op.text), `turn ${op.text} reaches a ready Mac`).toBe(true);
        break;
      case "periodic":
        await periodicSave(chat.ports);
        break;
      case "kill": {
        const current = chat.record();
        if (current?.kind !== "live") throw new Error("kill needs a live Mac");
        world.kill(current.mac.incarnation.instanceId);
        break;
      }
      default:
        op satisfies never;
    }
  }
  return { end: endState(world, chat), actionCounts, crashed };
}

const open: Op = { op: "goal", goal: "open" };
const release: Op = { op: "goal", goal: "release" };
const dispose: Op = { op: "goal", goal: "dispose" };
const turn = (text: string): Op => ({ op: "turn", text });
const periodic: Op = { op: "periodic" };
const kill: Op = { op: "kill" };

describe("driving a chat through a crash at every step", () => {
  it.each<{
    name: string;
    ops: ReadonlyArray<Op>;
    expected: ReturnType<typeof endState>;
  }>([
    {
      name: "a new chat saves periodically and finally on release",
      ops: [open, turn("a"), periodic, turn("b"), periodic, turn("c"), release],
      expected: {
        record: { kind: "idle", generation: 3, mode: "final", work: "abc" },
        liveInstances: 0,
        liveArtifacts: ["abc"],
        violations: [],
      },
    },
    {
      name: "a released chat resumes on a new Mac each time",
      ops: [open, turn("a"), release, open, turn("b"), release, open, turn("c"), release],
      expected: {
        record: { kind: "idle", generation: 3, mode: "final", work: "abc" },
        liveInstances: 0,
        liveArtifacts: ["abc"],
        violations: [],
      },
    },
    {
      name: "disposing a live chat leaves nothing",
      ops: [open, turn("a"), periodic, dispose],
      expected: {
        record: null,
        liveInstances: 0,
        liveArtifacts: [],
        violations: [],
      },
    },
    {
      name: "disposing an idle chat leaves nothing",
      ops: [open, turn("a"), release, dispose],
      expected: {
        record: null,
        liveInstances: 0,
        liveArtifacts: [],
        violations: [],
      },
    },
    {
      name: "a Mac destroyed out of band loses only the work since its last save",
      ops: [open, turn("a"), periodic, turn("b"), kill, release, open, turn("c"), release],
      expected: {
        record: { kind: "idle", generation: 2, mode: "final", work: "ac" },
        liveInstances: 0,
        liveArtifacts: ["ac"],
        violations: [],
      },
    },
  ])("$name", async ({ ops, expected }) => {
    const reference = await runScenario(ops);
    expect(reference.end).toEqual(expected);

    let crashRuns = 0;
    for (const [op, count] of reference.actionCounts)
      for (let at = 0; at < count; at++)
        for (const when of ["before", "after"] as const) {
          const run = await runScenario(ops, { op, at, when });
          expect(run.crashed, `a crash fired ${when} action ${at} of op ${op}`).toBe(true);
          expect(run.end, `converged after a crash ${when} action ${at} of op ${op}`).toEqual(
            expected,
          );
          crashRuns++;
        }
    expect(crashRuns).toBeGreaterThan(2 * ops.filter((op) => op.op === "goal").length);
  });

  it("a reopen after a release stopped at its final save keeps the later work", async () => {
    let stoppedAfterFinal = 0;
    for (let at = 0; ; at++) {
      const world = makeWorld();
      const chat = makeChat(world);
      await chat.run("open");
      expect(chat.turn("a")).toBe(true);
      const stopped = await chat.run("release", { at, when: "after" });
      if (!stopped.crashed) break;
      const current = chat.record();
      if (current?.kind !== "live" || current.snapshot?.mode !== "final") continue;
      stoppedAfterFinal++;

      await chat.run("open");
      expect(chat.turn("b"), "the reopened chat takes turns").toBe(true);
      await chat.run("release");
      expect(endState(world, chat)).toEqual({
        record: { kind: "idle", generation: 2, mode: "final", work: "ab" },
        liveInstances: 0,
        liveArtifacts: ["ab"],
        violations: [],
      });
    }
    expect(stoppedAfterFinal, "some crash point leaves a recorded final on a live Mac").toBe(2);
  });
});

describe("saves racing each other", () => {
  async function liveChat() {
    const world = makeWorld();
    const chat = makeChat(world);
    await chat.run("open");
    chat.turn("a");
    expect(await periodicSave(chat.ports)).toBe("saved");
    chat.turn("b");
    return { world, chat };
  }
  const racing = (chat: Chat, during: () => Promise<unknown>): ChatPorts => ({
    ...chat.ports,
    perform: {
      ...chat.ports.perform,
      save: async (step) => {
        const outcome = await chat.ports.perform.save(step);
        await during();
        return outcome;
      },
    },
  });

  it("refuses a periodic save that a newer save overtook, and expires its upload", async () => {
    const { world, chat } = await liveChat();

    const result = await periodicSave(racing(chat, () => periodicSave(chat.ports)));

    const recorded = chat.record()?.snapshot;
    expect(result).toBe("stale");
    expect(recorded?.generation).toBe(2);
    expect(world.facts("chat-1").artifacts).toEqual([recorded?.artifactPath]);
    expect(chat.durableWork()).toBe("ab");
  });

  it("refuses a periodic save that a release overtook", async () => {
    const { world, chat } = await liveChat();

    const result = await periodicSave(racing(chat, () => drive("release", chat.ports)));

    expect(result).toBe("stale");
    expect(endState(world, chat)).toEqual({
      record: { kind: "idle", generation: 2, mode: "final", work: "ab" },
      liveInstances: 0,
      liveArtifacts: ["ab"],
      violations: [],
    });
  });

  it("refuses a late save from a Mac that died after a new Mac took over", async () => {
    const { world, chat } = await liveChat();
    const lost = chat.record();
    if (lost?.kind !== "live") throw new Error("expected a live chat");

    const result = await periodicSave(
      racing(chat, async () => {
        world.kill(lost.mac.incarnation.instanceId);
        await drive("open", chat.ports);
      }),
    );

    const after = chat.record();
    expect(result).toBe("stale");
    expect(after).toMatchObject({
      kind: "live",
      mac: { incarnation: { instanceId: "mac-2" }, cache: "ready" },
    });
    expect(after?.snapshot?.generation).toBe(1);
    expect(world.facts("chat-1").artifacts).toEqual([after?.snapshot?.artifactPath]);
    expect(chat.durableWork()).toBe("a");
  });
});

/** mulberry32: a small seeded generator, so every run replays exactly. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("a seeded run of goals, turns, crashes and deaths", () => {
  it.each([1, 7, 42, 2026])("keeps the chat intact with seed %i", async (seed) => {
    const random = seeded(seed);
    const pick = <T>(items: readonly [T, ...T[]]): T =>
      items[Math.floor(random() * items.length)] ?? items[0];
    const world = makeWorld();
    const chat = makeChat(world);
    let expected = "";
    let turns = 0;

    const reach = async (goal: ChatGoal) => {
      for (let attempt = 0; ; attempt++) {
        const crash =
          attempt < 4 && random() < 0.4
            ? { at: Math.floor(random() * 8), when: pick(["before", "after"] as const) }
            : null;
        if ((await chat.run(goal, crash)).completed) return;
      }
    };
    const checkReleased = (step: number) => {
      expect(chat.record()?.kind ?? "idle", `step ${step}: released`).toBe("idle");
      expect(chat.durableWork(), `step ${step}: release kept every turn`).toBe(expected);
      const snapshot = chat.record()?.snapshot;
      expect(world.facts("chat-1"), `step ${step}: release left one snapshot`).toEqual({
        instances: [],
        artifacts: snapshot ? [snapshot.artifactPath] : [],
        now: NOW,
      });
    };

    for (let step = 0; step < 300; step++) {
      const action = pick([
        "open",
        "open",
        "release",
        "release",
        "dispose",
        "turn",
        "turn",
        "turn",
        "periodic",
        "kill",
        "race",
      ] as const);
      switch (action) {
        case "open": {
          await reach("open");
          const current = chat.record();
          const mac =
            current?.kind === "live" ? world.macs.get(current.mac.incarnation.instanceId) : null;
          expect(current?.kind === "live" && current.mac.cache, `step ${step}: opened`).toMatch(
            /^ready$/,
          );
          expect(mac?.root?.work, `step ${step}: open restored every saved turn`).toBe(expected);
          break;
        }
        case "release":
          await reach("release");
          checkReleased(step);
          break;
        case "dispose":
          await reach("dispose");
          expected = "";
          expect(chat.record(), `step ${step}: disposed`).toBe(null);
          expect(world.facts("chat-1"), `step ${step}: dispose left nothing`).toEqual({
            instances: [],
            artifacts: [],
            now: NOW,
          });
          break;
        case "turn": {
          const text = `t${++turns}.`;
          if (chat.turn(text)) expected += text;
          break;
        }
        case "periodic":
          await periodicSave(chat.ports);
          break;
        case "kill": {
          const current = chat.record();
          if (
            current?.kind === "live" &&
            world.macs.get(current.mac.incarnation.instanceId)?.fate === "alive"
          ) {
            world.kill(current.mac.incarnation.instanceId);
            expected = chat.durableWork();
          }
          break;
        }
        case "race": {
          const raced = await periodicSave({
            ...chat.ports,
            perform: {
              ...chat.ports.perform,
              save: async (save) => {
                const outcome = await chat.ports.perform.save(save);
                await reach("release");
                return outcome;
              },
            },
          });
          if (raced === "skipped") await reach("release");
          expect(raced, `step ${step}: a save overtaken by release`).toMatch(/^(stale|skipped)$/);
          checkReleased(step);
          break;
        }
        default:
          action satisfies never;
      }
      expect(world.violations, `step ${step}: ${action}`).toEqual([]);
    }

    expect(
      [...world.macs.values()].filter((mac) => mac.fate === "alive").length,
      "at most the chat's current Mac is left running",
    ).toBeLessThanOrEqual(1);
  });
});
