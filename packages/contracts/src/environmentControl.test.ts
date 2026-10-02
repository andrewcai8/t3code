import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DiscoveredProvisionedEnvironment } from "./environmentControl.ts";

const decodeDiscovered = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment);

const row = {
  requestId: "11111111-1111-4111-a111-000000000001",
  leaseId: "11111111-1111-4111-a111-000000000001",
  sandboxId: "sandbox-1",
  lifecycle: "paused",
  environmentId: "box-1",
  provider: "e2b",
  label: "t3code · E2B",
  repository: "pingdotgg/t3code",
  projectDir: "/home/user/work/t3code",
  threadId: "thread-1",
  createdAt: "2026-09-30T10:00:00.000Z",
  expiresAt: "2026-10-30T10:00:00.000Z",
};
const chat = (sessionStatus: string) => ({
  sequence: 42,
  project: {
    id: "project-app",
    title: "t3code",
    workspaceRoot: "/home/user/work/t3code",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
  },
  thread: {
    id: "thread-1",
    projectId: "project-app",
    title: "Fix the login redirect",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    branch: "main",
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-30T10:01:00.000Z",
    updatedAt: "2026-09-30T10:05:00.000Z",
    session: {
      threadId: "thread-1",
      status: sessionStatus,
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-30T10:05:00.000Z",
    },
    latestUserMessageAt: "2026-09-30T10:02:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  },
});

describe("DiscoveredProvisionedEnvironment", () => {
  it("keeps a box's chat it can read", () => {
    const decoded = decodeDiscovered({ ...row, chat: chat("ready") });
    expect([decoded.chat?.sequence, decoded.chat?.thread.title]).toEqual([
      42,
      "Fix the login redirect",
    ]);
  });

  it("drops a chat from a newer host it cannot read and keeps the rest of the box", () => {
    expect(decodeDiscovered({ ...row, chat: chat("pondering") })).toEqual(row);
  });
});
