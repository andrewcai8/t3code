// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - a local stand-in serves each fake box's T3 port.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProvisionOperation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ProvisionedSandboxMissing } from "./driver.ts";
import { makeModalChatStore, type ModalChatRecord } from "./modalChatStore.ts";
import { makeModalRuntime, modalEgress, type ModalBoxes } from "./ModalRuntime.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";
import { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";

const chatId = "6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f";
const environmentId = "env-modal-1";
const HOUR = 3_600_000;
const decodeOperation = Schema.decodeUnknownSync(ProvisionOperation);
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/**
 * Modal as the runtime sees it: named sandboxes that a snapshot ends and a restore brings back
 * under the same name. Each box serves its T3 port on a local server that says which box it is.
 */
async function fakeModal() {
  const boxes = new Map<string, { name: string; alive: boolean; origin?: string }>();
  const snapshots = new Map<string, string>();
  const calls: string[] = [];
  let next = 0;
  const running = (name: string) =>
    [...boxes].find(([, box]) => box.alive && box.name === name)?.[0] ?? null;
  const start = (name: string) => {
    if (running(name)) return "exists" as const;
    const sandboxId = `sb-${++next}`;
    boxes.set(sandboxId, { name, alive: true });
    return sandboxId;
  };
  const serve = async (sandboxId: string) => {
    const server = NodeHttp.createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/.well-known/t3/environment" ? { environmentId } : { sandboxId },
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No port");
    return `http://127.0.0.1:${address.port}`;
  };
  const api: ModalBoxes = {
    find: async (_app, name) => running(name),
    create: async (spec) => {
      calls.push("create");
      return start(spec.name);
    },
    restore: async (snapshotId) => {
      calls.push("restore");
      const name = snapshots.get(snapshotId);
      return name === undefined ? "expired" : start(name);
    },
    snapshot: async (sandboxId) => {
      calls.push("snapshot");
      const box = boxes.get(sandboxId);
      if (!box?.alive) throw new Error("not running");
      box.alive = false;
      const snapshotId = `sn-${++next}`;
      snapshots.set(snapshotId, box.name);
      return snapshotId;
    },
    alive: async (sandboxId) => boxes.get(sandboxId)?.alive === true,
    terminate: async (sandboxId) => {
      calls.push(`terminate ${sandboxId}`);
      const box = boxes.get(sandboxId);
      if (box) box.alive = false;
    },
    tunnel: async (sandboxId) => {
      const box = boxes.get(sandboxId);
      if (!box) throw new Error("no box");
      box.origin ??= await serve(sandboxId);
      return box.origin;
    },
    exec: async (sandboxId, argv, { stdin = "" }) => {
      if (!boxes.get(sandboxId)?.alive) return { exitCode: 255, stdout: "", stderr: "gone" };
      const script = argv.at(-1) ?? "";
      if (script.includes("pairing-token"))
        return {
          exitCode: 0,
          stdout: '{"credential":"pair-1","brokerToken":"broker-1"}',
          stderr: "",
        };
      if (JSON.parse(stdin || "{}").checkOnly)
        return { exitCode: 0, stdout: '{"refreshError":null,"serverReady":true}', stderr: "" };
      return { exitCode: 1, stdout: "", stderr: `unexpected exec ${argv.join(" ")}` };
    },
    upload: async () => {},
  };
  return { api, boxes, calls, running };
}

async function setup(options: { readonly now?: number } = {}) {
  const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-modal-"));
  cleanups.push(() => NodeFSP.rm(stateDir, { recursive: true, force: true }));
  const modal = await fakeModal();
  const proxies = new NamespaceProxyManager();
  cleanups.push(() => proxies.close({ proxyId: `provision-${chatId}` }));
  let clock = options.now ?? 1_000_000;
  const runtime = makeModalRuntime({ boxes: modal.api, stateDir, proxies, now: () => clock });
  const store = makeModalChatStore(stateDir);
  const request = {
    requestId: chatId,
    provider: "modal",
    providerInstanceId: "codex",
    sourceRevision: null,
    preparationHash: "a".repeat(64),
    app: "t3-cloud-chats",
    imageId: "im-1",
    sizing: { cpu: 8, cpuLimit: 8, memoryMiB: 8192, memoryLimitMiB: 32_768 },
  };
  const manifest = decodeManifest({
    input: { requestId: chatId, provider: "modal", providerInstanceId: "codex" },
    request,
    preparation: {
      requestId: chatId,
      root: "/home/user/.t3-provision",
      repository: null,
      artifact: {
        archivePath: "/tmp/t3-runtime.tar",
        sha256: "d".repeat(64),
        revision: "c".repeat(40),
        entrypoint: "cli.mjs",
      },
      runtimeExecutable: "node",
      port: 3773,
      readinessTimeoutSeconds: 10,
      brokerTtl: "1h",
      files: [],
    },
    localArtifact: {
      path: "/nonexistent/runtime.tar",
      sha256: "d".repeat(64),
      revision: "c".repeat(40),
      entrypoint: "cli.mjs",
      runtimeExecutable: "node",
    },
    egressAllow: [],
  });
  const operation = decodeOperation({
    request,
    requestHash: "b".repeat(64),
    revision: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    state: {
      kind: "ready",
      allocation: { kind: "direct", resource: { provider: "modal", chatId } },
      readiness: {
        environmentId,
        projectDir: "/home/user/.t3-provision/workspace",
        sourceRevision: null,
        preparationHash: "a".repeat(64),
        t3Revision: "c".repeat(40),
        artifactSha256: "d".repeat(64),
      },
    },
  });
  /** A chat already awake on a box, as a finished prepare leaves it. */
  const awakeOn = async (startedAt = clock) => {
    const sandboxId = await modal.api.create({
      app: "t3-cloud-chats",
      name: `t3-chat-${chatId}`,
      imageId: "im-1",
      port: 3773,
      timeoutMs: 24 * HOUR,
      sizing: request.sizing,
      tags: {},
      egress: { domains: [], cidrs: [] },
    });
    if (sandboxId === "exists") throw new Error("already awake");
    await store.write(chatId, { kind: "awake", sandboxId, startedAt, chainStartedAt: null });
    modal.calls.length = 0;
    return sandboxId;
  };
  return {
    modal,
    runtime,
    manifest,
    operation,
    awakeOn,
    record: () => store.read(chatId),
    overwrite: (record: ModalChatRecord) => store.write(chatId, record),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const whoAnswers = async (origin: string) =>
  ((await (await fetch(`${origin}/whoami`)).json()) as { sandboxId: string }).sandboxId;

describe("Modal runtime", () => {
  it("sleeps a chat into a memory snapshot and wakes it on a new box at the same origin", async () => {
    const t = await setup();
    const first = await t.awakeOn();
    const attached = await t.runtime.attach(t.operation, t.manifest);
    expect(attached.pairingUrl).toBe(`${attached.namespaceProxy.proxyOrigin}/pair#token=pair-1`);
    expect(await whoAnswers(attached.namespaceProxy.proxyOrigin)).toBe(first);

    expect(await t.runtime.release(t.operation)).toBe("released");
    expect(t.modal.boxes.get(first)?.alive).toBe(false);
    expect(await t.record()).toEqual({
      kind: "asleep",
      snapshotId: "sn-2",
      chainStartedAt: 1_000_000,
    });
    expect(await t.runtime.touch(t.operation)).toBe("released");

    const resumed = await t.runtime.resume(t.operation, t.manifest, attached.namespaceProxy);
    expect(resumed.namespaceProxy).toEqual(attached.namespaceProxy);
    expect(resumed.restarted).toBe(false);
    const second = t.modal.running(`t3-chat-${chatId}`);
    expect(second).toBe("sb-3");
    expect(await whoAnswers(attached.namespaceProxy.proxyOrigin)).toBe("sb-3");
    expect(await t.runtime.touch(t.operation)).toBe("running");
    expect(t.modal.calls).toEqual(["snapshot", "restore"]);
  });

  it("keeps the chain's first snapshot time across a second sleep, and refuses it once expired", async () => {
    const t = await setup();
    await t.awakeOn();
    await t.runtime.release(t.operation);
    t.advance(2 * 86_400_000);
    await t.runtime.resume(t.operation, t.manifest);
    expect(await t.runtime.release(t.operation)).toBe("released");
    expect((await t.record())?.chainStartedAt).toBe(1_000_000);

    t.advance(5 * 86_400_000);
    expect(await t.runtime.touch(t.operation)).toBe("missing");
    await expect(t.runtime.resume(t.operation, t.manifest)).rejects.toBeInstanceOf(
      ProvisionedSandboxMissing,
    );
    expect(t.modal.calls.filter((call) => call === "restore")).toEqual(["restore"]);
  });

  it("adopts the box a wake left running when its record still says asleep", async () => {
    const t = await setup();
    await t.awakeOn();
    await t.runtime.release(t.operation);
    const asleep = await t.record();
    // A wake that restored the box and crashed before recording it.
    await t.runtime.resume(t.operation, t.manifest);
    if (asleep) await t.overwrite(asleep);

    await t.runtime.resume(t.operation, t.manifest);

    expect([...t.modal.boxes.values()].filter((box) => box.alive)).toHaveLength(1);
    expect(await t.record()).toMatchObject({ kind: "awake", sandboxId: "sb-3" });
  });

  it("settles a snapshot a crash interrupted by whether its box is still running", async () => {
    const t = await setup();
    const sandboxId = await t.awakeOn();
    await t.overwrite({ kind: "saving", sandboxId, startedAt: 1_000_000, chainStartedAt: null });
    expect(await t.runtime.touch(t.operation)).toBe("running");
    expect(await t.runtime.release(t.operation)).toBe("released");

    const again = await setup();
    const lost = await again.awakeOn();
    await again.overwrite({
      kind: "saving",
      sandboxId: lost,
      startedAt: 1_000_000,
      chainStartedAt: null,
    });
    again.modal.boxes.get(lost)!.alive = false;
    expect(await again.runtime.touch(again.operation)).toBe("missing");
    await expect(again.runtime.resume(again.operation, again.manifest)).rejects.toBeInstanceOf(
      ProvisionedSandboxMissing,
    );
  });

  it("snapshots a box before Modal's lifetime cap, idle ones to sleep and busy ones to move", async () => {
    const t = await setup();
    await t.awakeOn();
    const busy = async () => false;
    const idle = async () => true;
    t.advance(22 * HOUR);
    expect(await t.runtime.upkeep(t.operation, idle)).toBe("kept");
    t.advance(HOUR + 10 * 60_000);
    expect(await t.runtime.upkeep(t.operation, busy)).toBe("kept");
    t.advance(35 * 60_000);
    expect(await t.runtime.upkeep(t.operation, busy)).toBe("reopen");
    expect((await t.record())?.kind).toBe("asleep");
    expect(await t.runtime.upkeep(t.operation, busy)).toBe("reopen");

    const other = await setup();
    await other.awakeOn();
    other.advance(23 * HOUR + 10 * 60_000);
    expect(await other.runtime.upkeep(other.operation, idle)).toBe("released");
  });

  it("reports a box Modal ended without a snapshot as missing", async () => {
    const t = await setup();
    const sandboxId = await t.awakeOn();
    t.modal.boxes.get(sandboxId)!.alive = false;
    expect(await t.runtime.upkeep(t.operation, async () => true)).toBe("missing");
    expect(await t.runtime.release(t.operation)).toBe("missing");
  });

  it("disposes the running box and forgets the chat", async () => {
    const t = await setup();
    const sandboxId = await t.awakeOn();
    await t.runtime.dispose(t.operation);
    expect(t.modal.calls).toEqual([`terminate ${sandboxId}`]);
    expect(await t.record()).toBe(null);
    expect(await t.runtime.touch(t.operation)).toBe("missing");
  });
});

describe("modalEgress", () => {
  it("passes addresses as CIDRs and everything else as domains", () => {
    expect(modalEgress(["github.com", "*.npmjs.org", "10.0.0.0/8", "1.2.3.4"])).toEqual({
      domains: ["github.com", "*.npmjs.org"],
      cidrs: ["10.0.0.0/8", "1.2.3.4"],
    });
  });
});
