// @effect-diagnostics globalDate:off - these tests pin read times.
import type { ProvisionedChat } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { createProvisionedChatStore, ownerChat } from "./provisionedChats.ts";
import { boxThread as thread, boxShell as shellBody } from "./shellTestFixture.ts";

describe("ownerChat", () => {
  it("takes the owner's thread and its project out of the box's shell", () => {
    const chat = ownerChat(
      shellBody([
        thread("thread-scratch", "project-other", "Scratch"),
        thread("thread-owner", "project-app", "Fix the login redirect"),
      ]),
      "thread-owner",
    );
    expect(chat?.sequence).toBe(42);
    expect(chat?.thread.id).toBe("thread-owner");
    expect(chat?.thread.title).toBe("Fix the login redirect");
    expect(chat?.project.id).toBe("project-app");
    expect(chat?.project.workspaceRoot).toBe("/home/user/work/app");
  });

  it("finds no chat on a box whose shell has no owner thread yet", () => {
    expect(
      ownerChat(shellBody([thread("thread-scratch", "project-other", "Scratch")]), "thread-owner"),
    ).toBeNull();
  });

  it("reads nothing from a shell it cannot decode, so the previous chat stays", () => {
    const { hasActionableProposedPlan: _, ...olderThread } = thread(
      "thread-owner",
      "project-app",
      "Fix the login redirect",
    );
    const olderShell = { ...shellBody([]), threads: [olderThread] };
    expect(ownerChat(olderShell, "thread-owner")).toBeUndefined();
    expect(ownerChat({ _tag: "EnvironmentAuthError" }, "thread-owner")).toBeUndefined();
  });
});

const chatAt = (sequence: number, title: string): ProvisionedChat => {
  const chat = ownerChat(
    { ...shellBody([thread("thread-owner", "project-app", title)]), snapshotSequence: sequence },
    "thread-owner",
  );
  if (!chat) throw new Error("fixture shell holds the owner thread");
  return chat;
};

const storedRows = Effect.fn(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    lease_id: string;
    sequence: number;
    chat_json: string;
    read_at: string;
  }>`SELECT lease_id, sequence, chat_json, read_at FROM provisioned_chats ORDER BY lease_id`;
  return rows.map((row) => ({
    leaseId: row.lease_id,
    sequence: row.sequence,
    title: (JSON.parse(row.chat_json) as ProvisionedChat).thread.title,
    readAt: row.read_at,
  }));
});

describe("ProvisionedChatStore", () => {
  effectIt.effect("keeps only a newer read of a box's chat, and a repeat writes nothing", () =>
    Effect.gen(function* () {
      const store = createProvisionedChatStore(yield* SqlClient.SqlClient);
      const record = (leaseId: string, chat: ProvisionedChat, at: string) =>
        Effect.promise(() => store.record(leaseId, chat, new Date(at)));
      yield* record("lease-a", chatAt(5, "First"), "2026-10-01T00:00:00.000Z");
      yield* record("lease-a", chatAt(5, "First"), "2026-10-01T00:05:00.000Z");
      yield* record("lease-a", chatAt(3, "Older"), "2026-10-01T00:10:00.000Z");
      expect(yield* storedRows()).toEqual([
        { leaseId: "lease-a", sequence: 5, title: "First", readAt: "2026-10-01T00:00:00.000Z" },
      ]);
      yield* record("lease-a", chatAt(9, "Renamed"), "2026-10-01T00:15:00.000Z");
      yield* record("lease-b", chatAt(1, "Other box"), "2026-10-01T00:20:00.000Z");
      expect(yield* storedRows()).toEqual([
        { leaseId: "lease-a", sequence: 9, title: "Renamed", readAt: "2026-10-01T00:15:00.000Z" },
        { leaseId: "lease-b", sequence: 1, title: "Other box", readAt: "2026-10-01T00:20:00.000Z" },
      ]);
      expect([...(yield* Effect.promise(() => store.leaseIds()))].toSorted()).toEqual([
        "lease-a",
        "lease-b",
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect("keeps a read of a new owner's chat even at the same sequence", () =>
    Effect.gen(function* () {
      const store = createProvisionedChatStore(yield* SqlClient.SqlClient);
      yield* Effect.promise(() => store.record("lease-a", chatAt(9, "First owner")));
      const claimed = ownerChat(
        {
          ...shellBody([thread("thread-claimed", "project-app", "Second owner")]),
          snapshotSequence: 9,
        },
        "thread-claimed",
      );
      if (!claimed) throw new Error("fixture shell holds the claimed thread");
      yield* Effect.promise(() => store.record("lease-a", claimed));
      expect((yield* storedRows()).map(({ sequence, title }) => ({ sequence, title }))).toEqual([
        { sequence: 9, title: "Second owner" },
      ]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
