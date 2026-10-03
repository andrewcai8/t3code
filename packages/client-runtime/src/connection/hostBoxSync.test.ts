import {
  EnvironmentId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  ProjectId,
  type ProvisionedChat,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ProvisionedBox } from "../cloud/provisioning.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { chatShellSnapshot, planHostBoxSync, withHostChat } from "./hostBoxSync.ts";
import { BearerConnectionTarget } from "./model.ts";
import { v2ShellSnapshot, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";

const HOST = EnvironmentId.make("host");
const OTHER_HOST = EnvironmentId.make("other-host");

const PROJECT: OrchestrationProjectShell = {
  id: ProjectId.make("project-1"),
  title: "t3code",
  workspaceRoot: "/workspace/t3code",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const THREAD: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  id: ThreadId.make("thread-1"),
  projectId: PROJECT.id,
  title: "Fix the flaky test",
};

function chat(sequence: number): ProvisionedChat {
  return { sequence, project: PROJECT, thread: THREAD };
}

function box(id: string, overrides: Partial<ProvisionedBox> = {}): ProvisionedBox {
  return {
    managerId: HOST,
    environmentId: EnvironmentId.make(id),
    leaseId: `lease-${id}`,
    threadId: ThreadId.make(`thread-${id}`),
    lifecycle: "active",
    label: "t3code · E2B",
    automationId: null,
    chat: null,
    ...overrides,
  };
}

function saved(
  id: string,
  options: {
    readonly managerId?: EnvironmentId | null;
    readonly paired?: boolean;
    readonly label?: string;
    readonly missing?: boolean;
  } = {},
): readonly [EnvironmentId, ConnectionCatalogEntry] {
  const environmentId = EnvironmentId.make(id);
  const managerId = options.managerId === undefined ? HOST : options.managerId;
  const target = new BearerConnectionTarget({
    environmentId,
    label: options.label ?? "t3code · E2B",
    connectionId: `bearer:${id}`,
    ...(managerId === null ? {} : { box: { managerId } }),
    ...(options.missing ? { workspaceStatus: "missing" as const } : {}),
  });
  const profile = new BearerConnectionProfile({
    connectionId: target.connectionId,
    environmentId,
    label: "e2b.local",
    httpBaseUrl: `https://${id}.example.test`,
    wsBaseUrl: `wss://${id}.example.test`,
  });
  return [
    environmentId,
    {
      target,
      profile: options.paired === false ? Option.none() : Option.some(profile),
      enabled: true,
    },
  ];
}

function plan(input: {
  readonly entries?: ReadonlyArray<readonly [EnvironmentId, ConnectionCatalogEntry]>;
  readonly boxes: ReadonlyArray<ProvisionedBox>;
  readonly cachedSequences?: ReadonlyArray<readonly [string, number]>;
  readonly connected?: ReadonlyArray<string>;
}) {
  return planHostBoxSync({
    managerId: HOST,
    entries: new Map(input.entries ?? []),
    boxes: input.boxes,
    cachedSequences: new Map(
      (input.cachedSequences ?? []).map(([id, sequence]) => [EnvironmentId.make(id), sequence]),
    ),
    connected: new Set((input.connected ?? []).map((id) => EnvironmentId.make(id))),
  });
}

describe("planHostBoxSync", () => {
  it("adopts each chat box its host lists, unpaired and with its chat", () => {
    expect(
      plan({
        boxes: [box("active-box", { chat: chat(4) }), box("paused-box", { lifecycle: "paused" })],
      }),
    ).toEqual([
      {
        _tag: "Adopt",
        target: new BearerConnectionTarget({
          environmentId: EnvironmentId.make("active-box"),
          label: "t3code · E2B",
          connectionId: "bearer:active-box",
          box: { managerId: HOST },
        }),
        chat: chat(4),
      },
      {
        _tag: "Adopt",
        target: new BearerConnectionTarget({
          environmentId: EnvironmentId.make("paused-box"),
          label: "t3code · E2B",
          connectionId: "bearer:paused-box",
          box: { managerId: HOST },
        }),
        chat: null,
      },
    ]);
  });

  it("leaves automation runs, unclaimed and gone boxes, and hosts unadopted", () => {
    expect(
      plan({
        entries: [
          saved("hosting-box", { managerId: null }),
          saved("hosted", { managerId: EnvironmentId.make("hosting-box") }),
        ],
        boxes: [
          box("automation-run", { automationId: "nightly" }),
          box("unclaimed", { threadId: null }),
          box("gone", { lifecycle: "disposed" }),
          box("lost", { lifecycle: "missing" }),
          box("host"),
          box("hosting-box"),
          box("other-host-box", { managerId: OTHER_HOST }),
        ],
      }),
    ).toEqual([]);
  });

  it("relabels a saved box and marks a legacy saved connection as the box it is", () => {
    expect(
      plan({
        entries: [
          saved("box-1", { label: "e2b.local" }),
          saved("legacy", { managerId: null, label: "e2b.local" }),
        ],
        boxes: [box("box-1"), box("legacy")],
      }),
    ).toEqual([
      { _tag: "Relabel", environmentId: "box-1", label: "t3code · E2B" },
      { _tag: "MarkBox", environmentId: "legacy", box: { managerId: HOST }, label: "t3code · E2B" },
    ]);
  });

  it("forgets an unpaired box that is gone, and keeps a paired one readable as missing", () => {
    expect(
      plan({
        entries: [
          saved("disposed-unpaired", { paired: false }),
          saved("unlisted-unpaired", { paired: false }),
          saved("disposed-paired"),
          saved("missing-unpaired", { paired: false }),
          saved("already-missing", { missing: true }),
          saved("unlisted-paired"),
          saved("paused-paired"),
          saved("other-hosts-unpaired", { managerId: OTHER_HOST, paired: false }),
        ],
        boxes: [
          box("disposed-unpaired", { lifecycle: "disposed" }),
          box("disposed-paired", { lifecycle: "disposed" }),
          box("missing-unpaired", { lifecycle: "missing" }),
          box("already-missing", { lifecycle: "disposed" }),
          box("paused-paired", { lifecycle: "paused" }),
        ],
      }),
    ).toEqual([
      { _tag: "Forget", environmentId: "disposed-unpaired", disposed: true },
      { _tag: "MarkMissing", environmentId: "disposed-paired" },
      { _tag: "MarkMissing", environmentId: "missing-unpaired" },
      { _tag: "Forget", environmentId: "unlisted-unpaired", disposed: false },
    ]);
  });

  it("reseeds a box's cache only from a newer chat, and never while the box is connected", () => {
    expect(
      plan({
        entries: [saved("older"), saved("same"), saved("uncached"), saved("live")],
        boxes: [
          box("older", { chat: chat(7) }),
          box("same", { chat: chat(5) }),
          box("uncached", { chat: chat(2) }),
          box("live", { chat: chat(9) }),
        ],
        cachedSequences: [
          ["older", 5],
          ["same", 5],
          ["live", 5],
        ],
        connected: ["live"],
      }),
    ).toEqual([
      { _tag: "Reseed", environmentId: "older", chat: chat(7) },
      { _tag: "Reseed", environmentId: "uncached", chat: chat(2) },
    ]);
  });
});

describe("chatShellSnapshot", () => {
  it("is the box's shell as its host last read it", () => {
    expect(chatShellSnapshot(chat(12))).toEqual({
      schemaVersion: 1,
      snapshotSequence: 12,
      projects: [PROJECT],
      threads: [THREAD],
      archivedThreads: [],
    });
  });
});

describe("withHostChat", () => {
  const otherThread = { ...THREAD, id: ThreadId.make("thread-subagent"), title: "Subagent" };
  const cached = {
    ...v2ShellSnapshot,
    snapshotSequence: 5,
    projects: [{ ...PROJECT, title: "old title" }],
    threads: [otherThread, { ...THREAD, title: "Old title" }],
  };

  it("takes a newer chat in place of its cached copy and keeps the box's other threads", () => {
    expect(withHostChat(Option.some(cached), chat(8))).toEqual({
      ...v2ShellSnapshot,
      snapshotSequence: 8,
      projects: [PROJECT],
      threads: [otherThread, THREAD],
    });
  });

  it("drops a chat the host lists as archived from the active threads", () => {
    const archived = { ...THREAD, archivedAt: DateTime.makeUnsafe("2026-10-01T02:00:00.000Z") };
    expect(
      withHostChat(Option.some(cached), { sequence: 9, project: PROJECT, thread: archived }),
    ).toEqual({
      ...v2ShellSnapshot,
      snapshotSequence: 9,
      projects: [PROJECT],
      threads: [otherThread],
    });
  });

  it("keeps a shell that already holds the chat or a newer one", () => {
    expect([
      withHostChat(Option.some(cached), chat(5)),
      withHostChat(Option.some(cached), chat(4)),
    ]).toEqual([null, null]);
  });

  it("is the chat alone when nothing is cached", () => {
    expect(withHostChat(Option.none(), chat(3))).toEqual(chatShellSnapshot(chat(3)));
  });
});
