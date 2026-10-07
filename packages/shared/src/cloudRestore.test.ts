import { assert, describe, it } from "@effect/vitest";

import { planCloudRestore } from "./cloudRestore.ts";

describe("planCloudRestore", () => {
  const uri = "s3://bucket/t3-agents/env-1/backups/latest/";
  const WHY = "E2B could not start it.";
  const manifest = {
    version: 1 as const,
    environmentId: "env-1",
    leaseId: "lease-1",
    account: "claude-a",
    threadId: "thread-1",
    title: "Fix the login page",
    modelSelection: null,
    workspace: "/home/user/.t3-provision/workspace",
    repository: "https://github.com/acme/app.git",
    branch: "fix-login",
    head: "abc123",
    branchOnOrigin: true,
    defaultBranch: "main",
    backupBranches: ["t3-backup/lease-1", "t3-backup/lease-1-stash-0"],
    bundle: null,
    sessions: [
      {
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        nativeId: "s-old",
        files: ["claudeAgent/projects/-w/s-old.jsonl"],
      },
      {
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        nativeId: "s-new",
        files: [
          "claudeAgent/projects/-w/s-new.jsonl",
          "claudeAgent/projects/-w/s-new/subagents/a.jsonl",
        ],
      },
    ],
  };

  it("restores the latest Claude session on the main checkout's backup branch", () => {
    const plan = planCloudRestore(manifest, uri, WHY);
    assert.deepStrictEqual(
      { ...plan, message: undefined },
      {
        repository: "acme/app",
        branch: "t3-backup/lease-1",
        bundle: null,
        checkout: "t3-backup/lease-1",
        sessionId: "s-new",
        transcript: "claudeAgent/projects/-w/s-new.jsonl",
        title: "Fix the login page",
        message: undefined,
      },
    );
    assert.include(plan.message, "Other unsaved work is on: t3-backup/lease-1-stash-0.");
    assert.include(plan.message, `(environment env-1): ${WHY}`);
  });

  it("starts a bundled backup on a branch origin has, then switches to the backup", () => {
    const bundled = { ...manifest, bundle: "work.bundle" };
    assert.deepStrictEqual(
      [
        planCloudRestore(bundled, uri, WHY),
        planCloudRestore({ ...bundled, branchOnOrigin: false }, uri, WHY),
      ].map(({ branch, bundle, checkout }) => ({ branch, bundle, checkout })),
      [
        { branch: "fix-login", bundle: "work.bundle", checkout: "t3-backup/lease-1" },
        { branch: "main", bundle: "work.bundle", checkout: "t3-backup/lease-1" },
      ],
    );
  });

  it("restores on the chat's own branch when the box had nothing unsaved there", () => {
    assert.strictEqual(
      planCloudRestore({ ...manifest, backupBranches: [] }, uri, WHY).branch,
      "fix-login",
    );
  });

  it("refuses a backup with no Claude session, naming what it holds", () => {
    assert.throws(
      () =>
        planCloudRestore(
          {
            ...manifest,
            sessions: [
              {
                driver: "codex",
                instanceId: "codex",
                nativeId: "c1",
                files: ["codex/sessions/r-c1.jsonl"],
              },
            ],
          },
          uri,
        ),
      `the backup holds no Claude session to restore (only codex, under ${uri})`,
    );
  });

  it("refuses a detached checkout that saved nothing", () => {
    assert.throws(
      () => planCloudRestore({ ...manifest, branch: null, backupBranches: [] }, uri, WHY),
      /names no branch/,
    );
  });
});
