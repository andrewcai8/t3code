import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  claudeProjectDirName,
  githubRepository,
  rewriteSessionCwd,
  snapshotCheckout,
} from "./moveChat.ts";

describe("claudeProjectDirName", () => {
  it("names the directories Claude Code keeps sessions in", () => {
    assert.strictEqual(
      claudeProjectDirName("/Users/andrew/.t3/worktrees/megpt-mono/t3code-702f8713"),
      "-Users-andrew--t3-worktrees-megpt-mono-t3code-702f8713",
    );
    assert.strictEqual(
      claudeProjectDirName("/home/user/.t3-provision/workspace"),
      "-home-user--t3-provision-workspace",
    );
  });

  it("refuses paths Claude would shorten with a hash", () => {
    assert.throws(() => claudeProjectDirName(`/${"a".repeat(200)}`));
  });
});

describe("rewriteSessionCwd", () => {
  it("rebases cwd fields and leaves message text alone", () => {
    const from = "/Users/andrew/.t3/worktrees/megpt-mono/t3code-702f8713";
    const to = "/home/user/.t3-provision/workspace";
    const lines = [
      `{"cwd":"${from}","message":{"content":"edit ${from}/a.ts"}}`,
      `{"cwd":"${from}/aura-hono-api","type":"user"}`,
      `{"cwd":"${from}-other","type":"user"}`,
    ].join("\n");
    assert.strictEqual(
      rewriteSessionCwd(lines, from, to),
      [
        `{"cwd":"${to}","message":{"content":"edit ${from}/a.ts"}}`,
        `{"cwd":"${to}/aura-hono-api","type":"user"}`,
        `{"cwd":"${from}-other","type":"user"}`,
      ].join("\n"),
    );
  });
});

describe("githubRepository", () => {
  it("reads owner/name from https and ssh remotes", () => {
    assert.strictEqual(
      githubRepository("https://github.com/Authentic-Intelligence/megpt-mono.git"),
      "Authentic-Intelligence/megpt-mono",
    );
    assert.strictEqual(
      githubRepository("git@github.com:andrewcai8/t3code.git"),
      "andrewcai8/t3code",
    );
    assert.strictEqual(githubRepository("https://gitlab.com/a/b.git"), null);
  });
});

describe("snapshotCheckout", () => {
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const repo = () => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "move-chat-"));
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "config", "user.email", "test@example.com");
    git(cwd, "config", "user.name", "test");
    NodeFS.writeFileSync(NodePath.join(cwd, ".gitignore"), ".env\n");
    NodeFS.writeFileSync(NodePath.join(cwd, "tracked.txt"), "one\n");
    NodeFS.writeFileSync(NodePath.join(cwd, "gone.txt"), "bye\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "base");
    return cwd;
  };

  it("answers HEAD for a clean checkout", () => {
    const cwd = repo();
    try {
      assert.strictEqual(snapshotCheckout(cwd, "snapshot"), git(cwd, "rev-parse", "HEAD"));
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("captures edits, deletions and untracked files without ignored ones or touching the checkout", () => {
    const cwd = repo();
    try {
      NodeFS.writeFileSync(NodePath.join(cwd, "tracked.txt"), "two\n");
      NodeFS.rmSync(NodePath.join(cwd, "gone.txt"));
      NodeFS.writeFileSync(NodePath.join(cwd, "new.txt"), "new\n");
      NodeFS.writeFileSync(NodePath.join(cwd, ".env"), "SECRET=1\n");
      git(cwd, "add", "new.txt");
      const statusBefore = git(cwd, "status", "--porcelain");
      const head = git(cwd, "rev-parse", "HEAD");

      const commit = snapshotCheckout(cwd, "snapshot");

      assert.strictEqual(git(cwd, "rev-parse", `${commit}^`), head);
      assert.strictEqual(
        git(cwd, "ls-tree", "--name-only", commit),
        [".gitignore", "new.txt", "tracked.txt"].join("\n"),
      );
      assert.strictEqual(git(cwd, "show", `${commit}:tracked.txt`), "two");
      assert.strictEqual(git(cwd, "rev-parse", "HEAD"), head);
      assert.strictEqual(git(cwd, "status", "--porcelain"), statusBefore);
    } finally {
      NodeFS.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
