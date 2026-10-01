// @effect-diagnostics nodeBuiltinImport:off - the store is exercised against a real private directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { ChatRecord, ChatSnapshot } from "./namespaceChat.ts";
import { makeChatStore } from "./namespaceChatStore.ts";
import { InstanceId } from "./namespaceInstances.ts";

let stateDir = "";
beforeEach(async () => {
  stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-namespace-chats-"));
});
afterEach(async () => {
  await NodeFSP.rm(stateDir, { recursive: true, force: true });
});

const instanceId = InstanceId.make("mac-1");
const snapshot = (generation: number): ChatSnapshot => ({
  generation,
  artifactPath: `t3/chats/chat-1/${generation}`,
  sha256: "a".repeat(64),
  bytes: 1024,
  fingerprint: `fp-${generation}`,
  mode: "live",
  fromInstance: instanceId,
  savedAt: 1_000,
});
const live: ChatRecord = {
  kind: "live",
  snapshot: snapshot(1),
  mac: {
    incarnation: { instanceId, site: "iad4", createdAt: 0, deadline: 18_000_000 },
    cache: "ready",
  },
};
const chatFile = (chatId: string) => NodePath.join(stateDir, "namespace-chats", `${chatId}.json`);

describe("namespace chat store", () => {
  it("reads back the record an update wrote, in a fresh store", async () => {
    await makeChatStore(stateDir).update("chat-1", () => ({ ok: true, record: live, garbage: [] }));

    expect(await makeChatStore(stateDir).read("chat-1")).toEqual(live);
    expect(await makeChatStore(stateDir).read("chat-2")).toBe(null);
  });

  it("removes the file when an update settles to no record", async () => {
    const store = makeChatStore(stateDir);
    await store.update("chat-1", () => ({ ok: true, record: live, garbage: [] }));

    await store.update("chat-1", () => ({ ok: true, record: null, garbage: [] }));

    expect(await store.read("chat-1")).toBe(null);
    await expect(NodeFSP.access(chatFile("chat-1"))).rejects.toThrow(/ENOENT/);
  });

  it("serializes concurrent updates on one chat so none is lost", async () => {
    const store = makeChatStore(stateDir);
    const bump = (current: ChatRecord | null) => ({
      ok: true as const,
      record: {
        kind: "idle" as const,
        snapshot: snapshot((current?.snapshot?.generation ?? 0) + 1),
      },
      garbage: [],
    });

    await Promise.all(Array.from({ length: 20 }, () => store.update("chat-1", bump)));

    expect((await store.read("chat-1"))?.snapshot?.generation).toBe(20);
  });

  it("keeps serving a chat after one of its updates throws", async () => {
    const store = makeChatStore(stateDir);
    const failed = store.update("chat-1", () => {
      throw new Error("settle bug");
    });
    const written = store.update("chat-1", () => ({ ok: true, record: live, garbage: [] }));

    await expect(failed).rejects.toThrow("settle bug");
    await written;
    expect(await store.read("chat-1")).toEqual(live);
  });

  it("writes nothing for a stale settle and returns it", async () => {
    const store = makeChatStore(stateDir);
    await store.update("chat-1", () => ({ ok: true, record: live, garbage: [] }));

    const result = await store.update("chat-1", () => ({
      ok: false,
      reason: "stale",
      garbage: ["t3/chats/chat-1/orphan"],
    }));

    expect(result).toEqual({ ok: false, reason: "stale", garbage: ["t3/chats/chat-1/orphan"] });
    expect(await store.read("chat-1")).toEqual(live);
  });

  it.each(["../escape", "a/b", ".hidden", "", "-leading", "x".repeat(129)])(
    "rejects the unsafe chat id %j",
    async (chatId) => {
      const store = makeChatStore(stateDir);

      await expect(store.read(chatId)).rejects.toThrow("is not a safe file name");
      await expect(
        store.update(chatId, () => ({ ok: true, record: live, garbage: [] })),
      ).rejects.toThrow("is not a safe file name");
      expect(await NodeFSP.readdir(stateDir)).toEqual([]);
    },
  );

  it("ignores a temporary file a crashed write left behind", async () => {
    const store = makeChatStore(stateDir);
    await store.update("chat-1", () => ({ ok: true, record: live, garbage: [] }));
    await NodeFSP.writeFile(`${chatFile("chat-1")}.0123.tmp`, "{ half written");
    await NodeFSP.writeFile(`${chatFile("chat-2")}.4567.tmp`, "{ half written");

    expect(await store.read("chat-1")).toEqual(live);
    expect(await store.read("chat-2")).toBe(null);
  });

  it("refuses a record that does not decode", async () => {
    await NodeFSP.mkdir(NodePath.dirname(chatFile("chat-1")), { recursive: true });
    await NodeFSP.writeFile(chatFile("chat-1"), JSON.stringify({ kind: "live", snapshot: null }));

    await expect(makeChatStore(stateDir).read("chat-1")).rejects.toThrow(/mac/);
  });
});
