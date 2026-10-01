// @effect-diagnostics nodeBuiltinImport:off - a local stand-in for Namespace runs the guest scripts as subprocesses.
// @effect-diagnostics globalDate:off - the stand-in gives Macs real deadlines, which the runtime reads from the clock.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ProvisionOperation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  artifactStore,
  freePort,
  world as makeWorld,
  type Cleanups,
  type World,
} from "./guestTestFixture.ts";
import { makeNamespaceMacRuntime } from "./NamespaceMacRuntime.ts";
import type { ChatRecord } from "./namespaceChat.ts";
import { makeChatStore } from "./namespaceChatStore.ts";
import {
  InstanceId,
  type Departure,
  type NamespaceArtifacts,
  type NamespaceInstances,
} from "./namespaceInstances.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";
import { ProvisionedSandboxMissing } from "./driver.ts";
import { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const decodeOperation = Schema.decodeUnknownSync(ProvisionOperation);
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);
const chatId = "6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const MINUTE = 60_000;

/**
 * Namespace as one machine at a time owning the world's volume: creating a Mac
 * forks the last committed volume, `commit` makes this one the next parent,
 * `abandon` and an out-of-band kill discard it.
 */
function fakeNamespace(w: World, lifetimeMs = 5 * 60 * MINUTE) {
  const macs = new Map<
    InstanceId,
    { readonly labels: Readonly<Record<string, string>>; alive: boolean; deadline: number }
  >();
  const departures: Array<{ instanceId: InstanceId; departure: Departure }> = [];
  /** Runs once inside the next `list`, as another operation would between its read and write. */
  let duringList: (() => Promise<void>) | null = null;
  const incarnation = (instanceId: InstanceId) => ({
    instanceId,
    site: "iad4",
    createdAt: 0,
    deadline: macs.get(instanceId)?.deadline ?? 0,
  });
  const live = (labels: Readonly<Record<string, string>>) =>
    [...macs]
      .filter(
        ([, mac]) =>
          mac.alive && Object.entries(labels).every(([name, value]) => mac.labels[name] === value),
      )
      .map(([instanceId]) => incarnation(instanceId));
  const instances: NamespaceInstances = {
    create: async (spec) => {
      if ([...macs.values()].some((mac) => mac.alive))
        throw new Error("this world holds one Mac at a time");
      await w.newMac();
      const instanceId = InstanceId.make(w.instance());
      macs.set(instanceId, {
        labels: { ...spec.labels },
        alive: true,
        deadline: Math.min(spec.deadline, Date.now() + lifetimeMs),
      });
      return incarnation(instanceId);
    },
    describe: async (instanceId) => (macs.get(instanceId)?.alive ? incarnation(instanceId) : null),
    list: async (labels) => {
      const interleaved = duringList;
      duringList = null;
      await interleaved?.();
      return live(labels);
    },
    exec: (instanceId, argv, options = {}) =>
      new Promise((resolve, reject) => {
        if (!macs.get(instanceId)?.alive)
          return resolve({ exitCode: 255, stdout: "", stderr: "the Mac is gone" });
        const [command = "", ...args] = argv;
        const child = NodeChildProcess.spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
        child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
        child.once("error", reject);
        child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
        child.stdin.end(options.stdin ?? "");
      }),
    depart: async (instanceId, departure) => {
      const mac = macs.get(instanceId);
      if (!mac?.alive) return;
      departures.push({ instanceId, departure });
      mac.alive = false;
      await w.depart(departure);
    },
    expose: async (_instanceId, port) => `http://127.0.0.1:${port}`,
    upload: async (_instanceId, localPath, guestPath) => NodeFSP.copyFile(localPath, guestPath),
  };
  return {
    instances,
    departures,
    interleave: (run: () => Promise<void>) => {
      duringList = run;
    },
    live: () => live({}).map(({ instanceId }) => instanceId),
    kill: async (instanceId: InstanceId) => {
      const mac = macs.get(instanceId);
      if (mac) mac.alive = false;
      await w.depart("abandon");
    },
  };
}

/** Artifact storage: labelled, finalized and expired by path, its bytes behind signed URLs. */
async function fakeArtifacts() {
  const store = await artifactStore(cleanups);
  const records = new Map<
    string,
    { readonly labels: Readonly<Record<string, string>>; finalized: boolean; expired: boolean }
  >();
  const uploads = new Map<string, string>();
  const expiries = new Map<string, number>();
  const isLive = (path: string) => {
    const record = records.get(path);
    return record !== undefined && record.finalized && !record.expired;
  };
  const artifacts: NamespaceArtifacts = {
    beginUpload: async ({ path, labels, expiresAt }) => {
      const uploadId = `upload-${uploads.size + 1}`;
      uploads.set(uploadId, path);
      expiries.set(path, expiresAt);
      records.set(path, { labels, finalized: false, expired: false });
      return { uploadId, signedUploadUrl: store.url(path) };
    },
    finalize: async (uploadId) => {
      const path = uploads.get(uploadId) ?? "";
      const record = records.get(path);
      if (!record || store.object(path) === undefined) throw new Error("nothing was uploaded");
      record.finalized = true;
      return { path, bytes: store.object(path)?.length ?? 0 };
    },
    downloadUrl: async (path) => {
      return isLive(path) ? store.url(path) : null;
    },
    expire: async (path) => {
      const record = records.get(path);
      if (record) record.expired = true;
    },
    list: async (labels) =>
      [...records]
        .filter(
          ([path, record]) =>
            isLive(path) &&
            Object.entries(labels).every(([name, value]) => record.labels[name] === value),
        )
        .map(([path]) => ({ path, bytes: store.object(path)?.length ?? 0, expiresAt: null })),
  };
  return {
    artifacts,
    live: () => [...records.keys()].filter(isLive),
    expiryOf: (path: string) => expiries.get(path),
    bytesOf: (path: string) => store.object(path),
  };
}

const unreachable = async (): Promise<never> => {
  throw new Error("this test configures no Namespace artifacts");
};

/** Starts a service for the chat; a builder must not run it. Ignored by git, so `clean` keeps it. */
const BACKGROUND = "echo ran > background.bin";

async function setup(
  options: {
    readonly lifetimeMs?: number;
    readonly derivedHomePaths?: ReadonlyArray<string>;
    /** Prepare commands a builder runs instead of the chat's, as a `background` marker freezes. */
    readonly buildPrepareCommands?: (chatCommands: ReadonlyArray<string>) => ReadonlyArray<string>;
  } = {},
) {
  const { lifetimeMs, derivedHomePaths } = options;
  const w = await makeWorld(cleanups);
  const namespace = fakeNamespace(w, lifetimeMs);
  const storage = await fakeArtifacts();
  const proxies = new NamespaceProxyManager();
  cleanups.push(() => proxies.close({ proxyId: `provision-${chatId}` }));
  const stateDir = NodePath.join(w.base, "manager");
  const runtime = makeNamespaceMacRuntime({
    session: {
      artifacts: {
        createArtifact: unreachable,
        finalizeArtifact: unreachable,
        resolveArtifact: unreachable,
        listArtifacts: unreachable,
        expireArtifact: unreachable,
      },
      issueToken: async () => "token",
    },
    stateDir,
    proxies,
    instances: namespace.instances,
    artifacts: storage.artifacts,
    toolInstall: "true",
    // The world holds one Mac at a time, so builds run when a test frees it.
    startBuild: (build) => void builds.push(build),
  });
  const builds: Array<() => Promise<void>> = [];
  const prepared = await w.prepareInput(chatId, w.head());
  const prepareCommands = [...(prepared.prepareCommands ?? []), BACKGROUND];
  const manifest = decodeManifest({
    input: {
      requestId: chatId,
      provider: "namespace",
      providerInstanceId: "codex",
      repository: "example/repo",
    },
    request: {
      requestId: chatId,
      provider: "namespace",
      tenantId: "tenant",
      providerInstanceId: "codex",
      sourceRevision: null,
      preparationHash: "a".repeat(64),
      image: "tahoe-slim",
      size: "m",
      region: "iad",
      idleTimeoutMinutes: 30,
      engine: "instance",
    },
    preparation: {
      requestId: chatId,
      root: w.root,
      repository: prepared.repository,
      artifact: {
        ...prepared.artifact,
        archivePath: `${w.mount}/t3-runtime-${w.runtimeSha256}.tar`,
      },
      runtimeExecutable: prepared.runtimeExecutable,
      port: await freePort(),
      readinessTimeoutSeconds: 10,
      brokerTtl: "1h",
      prepareCommands,
      files: prepared.files,
    },
    localArtifact: {
      path: w.archivePath,
      sha256: w.runtimeSha256,
      revision: "c".repeat(40),
      entrypoint: "cli.mjs",
      runtimeExecutable: process.execPath,
    },
    egressAllow: [],
    ...(derivedHomePaths ? { derivedHomePaths } : {}),
    buildPrepareCommands: (options.buildPrepareCommands ?? ((commands) => commands.slice(0, -1)))(
      prepareCommands,
    ),
  });
  const operation = (environmentId: string, retentionDeadline?: string) =>
    decodeOperation({
      request: retentionDeadline ? { ...manifest.request, retentionDeadline } : manifest.request,
      requestHash: "b".repeat(64),
      revision: 1,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      state: {
        kind: "ready",
        allocation: {
          kind: "direct",
          resource: { provider: "namespace", engine: "instance", chatId },
        },
        readiness: {
          environmentId,
          projectDir: `${w.root}/workspace`,
          sourceRevision: null,
          preparationHash: "a".repeat(64),
          t3Revision: "c".repeat(40),
          artifactSha256: w.runtimeSha256,
        },
      },
    });
  const workspace = NodePath.join(w.root, "workspace");
  return {
    w,
    namespace,
    /** Template builds the runtime asked for and has not run yet. */
    builds,
    runBuilds: async () => {
      for (const build of builds.splice(0)) await build();
    },
    storage,
    runtime,
    manifest,
    operation,
    record: () => makeChatStore(stateDir).read(chatId),
    /** Writes the record as a concurrent release or resume under the per-box lock would. */
    overwrite: (next: ChatRecord) =>
      makeChatStore(stateDir).update(chatId, () => ({ ok: true, record: next, garbage: [] })),
    write: (name: string, text: string) => NodeFSP.writeFile(NodePath.join(workspace, name), text),
    read: (name: string) =>
      NodeFSP.readFile(NodePath.join(workspace, name), "utf8").catch(() => null),
  };
}

describe("Namespace Mac runtime", () => {
  it("asks for one build on a miss, saves while it works, releases, and resumes elsewhere with its work", async () => {
    const t = await setup();
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    expect(await t.record()).toMatchObject({ kind: "live", mac: { cache: "ready" } });
    expect(t.builds, "a miss asks for a build").toHaveLength(1);
    expect(await t.read("background.bin"), "a chat runs its background commands").toBe("ran\n");
    const op = t.operation(ready.environmentId);
    const attached = await t.runtime.attach(op, t.manifest);
    expect(attached.pairingUrl).toBe(
      `${attached.namespaceProxy.proxyOrigin}/pair#token=pair-credential`,
    );
    const busy = async () => false;

    await t.write("agent.txt", "first turn\n");
    expect(await t.runtime.upkeep(op, t.manifest, busy)).toBe("kept");
    expect(await t.runtime.upkeep(op, t.manifest, busy)).toBe("kept");
    expect(t.storage.live(), "an unchanged chat uploads nothing").toHaveLength(1);
    expect((await t.record())?.snapshot).toMatchObject({ generation: 1, mode: "live" });

    expect(await t.runtime.release(op, t.manifest)).toBe("released");
    expect(t.namespace.live()).toEqual([]);
    expect(await t.record()).toMatchObject({
      kind: "idle",
      snapshot: { generation: 1, mode: "final" },
    });

    const resumed = await t.runtime.resume(op, t.manifest, attached.namespaceProxy);
    expect(resumed.namespaceProxy).toEqual(attached.namespaceProxy);
    expect(t.builds, "another miss joins the build in flight").toHaveLength(1);
    expect(await t.read("agent.txt")).toBe("first turn\n");
    expect(await t.runtime.touch(op)).toBe("running");

    await t.write("agent.txt", "second turn\n");
    expect(await t.runtime.upkeep(op, t.manifest, busy)).toBe("kept");
    await t.write("agent.txt", "lost turn\n");
    const killed = await t.record();
    if (killed?.kind !== "live") throw new Error("expected a live Mac");
    await t.namespace.kill(killed.mac.incarnation.instanceId);
    expect(await t.runtime.touch(op), "a dead Mac's chat is released, not missing").toBe(
      "released",
    );
    await t.runtime.resume(op, t.manifest, attached.namespaceProxy);
    expect(await t.read("agent.txt"), "the last periodic save comes back").toBe("second turn\n");

    await t.runtime.dispose(op, t.manifest);
    expect([t.namespace.live(), t.storage.live(), await t.record()]).toEqual([[], [], null]);
    expect(t.namespace.departures.map(({ departure }) => departure)).toEqual([
      "abandon",
      "abandon",
    ]);
    expect(t.w.committedVolume(), "a chat's Mac never commits").toBeNull();
  });

  it("builds a template without the chat's background commands, which the next chat adopts", async () => {
    const t = await setup();
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    const op = t.operation(ready.environmentId);
    await t.write("agent.txt", "first turn\n");
    expect(await t.runtime.release(op, t.manifest)).toBe("released");
    await t.runBuilds();
    expect(t.namespace.departures.map(({ departure }) => departure)).toEqual(["abandon", "commit"]);
    const committed = t.w.committedVolume();
    if (committed === null) throw new Error("expected a committed volume");
    expect((await NodeFSP.readdir(committed)).toSorted(), "no root reaches the cache").toEqual([
      "cache.lock",
      `t3-runtime-${t.w.runtimeSha256}.tar`,
      "template",
      "template.json",
    ]);
    const template = NodePath.join(committed, "template", "workspace.partial");
    expect(await NodeFSP.readdir(template), "the builder ran no background command").not.toContain(
      "background.bin",
    );
    expect(await NodeFSP.readdir(NodePath.join(template, "node_modules"))).toContain(
      ".installed-at",
    );

    await t.runtime.resume(op, t.manifest);
    expect(t.builds, "a hit asks for no build").toEqual([]);
    expect(await t.read("agent.txt")).toBe("first turn\n");
    expect(await t.read("background.bin")).toBe("ran\n");
    expect(await t.runtime.release(op, t.manifest)).toBe("released");
    expect(t.w.committedVolume(), "the chat that adopted it leaves the cache as it was").toBe(
      committed,
    );
  });

  it("leaves a current template alone and never commits a build that failed", async () => {
    const failing = await setup({ buildPrepareCommands: () => ["exit 3"] });
    const opened = await failing.runtime.prepare(failing.operation("pending"), failing.manifest);
    await failing.runtime.release(failing.operation(opened.environmentId), failing.manifest);
    await failing.runBuilds();
    expect(failing.namespace.departures.map(({ departure }) => departure)).toEqual([
      "abandon",
      "abandon",
    ]);
    expect(failing.w.committedVolume()).toBeNull();

    const t = await setup();
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    await t.runtime.release(t.operation(ready.environmentId), t.manifest);
    const [build] = t.builds;
    if (build === undefined) throw new Error("expected a requested build");
    await build();
    const committed = t.w.committedVolume();
    // The same build again, as when a second manager or a later miss lands on a filled site.
    await build();
    expect(t.namespace.departures.map(({ departure }) => departure)).toEqual([
      "abandon",
      "commit",
      "abandon",
    ]);
    expect(t.w.committedVolume()).toBe(committed);
  });

  it("keeps a snapshot only as long as its lease's retention, and resumes an expired one as missing", async () => {
    const t = await setup();
    const retention = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const ready = await t.runtime.prepare(t.operation("pending", retention), t.manifest);
    const op = t.operation(ready.environmentId, retention);
    expect(await t.runtime.release(op, t.manifest)).toBe("released");
    const record = await t.record();
    const path = record?.snapshot?.artifactPath ?? "";
    expect(t.storage.expiryOf(path), "the snapshot expires with the lease").toBe(
      Date.parse(retention),
    );

    await t.storage.artifacts.expire(path);
    await expect(t.runtime.resume(op, t.manifest)).rejects.toBeInstanceOf(
      ProvisionedSandboxMissing,
    );
    expect(t.namespace.live(), "no Mac is opened for a chat with nothing to restore").toEqual([]);
  });

  it("leaves a repository's derived home paths out of its snapshots", async () => {
    const t = await setup({ derivedHomePaths: [".claude"] });
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    expect(await t.runtime.release(t.operation(ready.environmentId), t.manifest)).toBe("released");
    const bytes = t.storage.bytesOf((await t.record())?.snapshot?.artifactPath ?? "");
    if (bytes === undefined) throw new Error("expected a stored snapshot");
    const listed = NodeChildProcess.execFileSync("tar", ["-tf", "-"], {
      input: bytes,
      encoding: "utf8",
    }).split("\n");
    expect(listed.filter((entry) => entry.startsWith("home/.claude"))).toEqual([]);
    expect(listed).toContain("home/.t3/userdata/environment-id");
  });

  it("settles a heartbeat that saw a Mac gone against the record as it is when it writes", async () => {
    const t = await setup();
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    const op = t.operation(ready.environmentId);
    await t.write("agent.txt", "work\n");
    expect(await t.runtime.upkeep(op, t.manifest, async () => false)).toBe("kept");
    const before = await t.record();
    if (before?.kind !== "live" || before.snapshot === null)
      throw new Error("expected a saved live Mac");

    // A release lands between the heartbeat's read and its write: generation 2, Mac destroyed.
    const released: ChatRecord = {
      kind: "idle",
      snapshot: { ...before.snapshot, generation: 2, mode: "final" },
    };
    t.namespace.interleave(async () => {
      await t.namespace.kill(before.mac.incarnation.instanceId);
      await t.overwrite(released);
    });
    expect(await t.runtime.touch(op)).toBe("released");
    expect(await t.record(), "the newer snapshot survives a stale heartbeat").toEqual(released);

    // A resume lands on a new Mac while a heartbeat that saw the old one dead is in flight.
    const resumed: ChatRecord = {
      kind: "live",
      snapshot: released.snapshot,
      mac: {
        incarnation: { ...before.mac.incarnation, instanceId: InstanceId.make("mac-new") },
        cache: "ready",
      },
    };
    await t.overwrite({ ...before, snapshot: released.snapshot });
    // The heartbeat reads that record, sees its Mac gone, and the resume lands before it writes.
    t.namespace.interleave(() => t.overwrite(resumed).then(() => undefined));
    expect(await t.runtime.touch(op)).toBe("running");
    expect(await t.record(), "the resumed Mac is not dropped").toEqual(resumed);
    await t.runtime.dispose(op, t.manifest);
  });

  it("saves a Mac at most once per cadence but checks its deadline on every pass", async () => {
    const t = await setup();
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    const op = t.operation(ready.environmentId);
    const idle = async () => false;
    await t.write("agent.txt", "first\n");
    expect(await t.runtime.upkeep(op, t.manifest, idle)).toBe("kept");
    await t.write("agent.txt", "second\n");
    expect(await t.runtime.upkeep(op, t.manifest, idle)).toBe("kept");
    expect((await t.record())?.snapshot?.generation, "the next save waits for its cadence").toBe(1);
    await t.runtime.dispose(op, t.manifest);
  });

  it("releases a Mac near its deadline once its chat is idle, and refuses a missing snapshot", async () => {
    const t = await setup({ lifetimeMs: 20 * MINUTE });
    const ready = await t.runtime.prepare(t.operation("pending"), t.manifest);
    const op = t.operation(ready.environmentId);
    await t.write("agent.txt", "work\n");
    expect(await t.runtime.upkeep(op, t.manifest, async () => true)).toBe("kept");
    expect(await t.runtime.upkeep(op, t.manifest, async () => false)).toBe("released");
    expect(t.namespace.live()).toEqual([]);
    expect(await t.runtime.touch(op)).toBe("released");
    expect(t.namespace.departures.map(({ departure }) => departure)).toEqual(["abandon"]);
  });
});
