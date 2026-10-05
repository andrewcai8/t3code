import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

import {
  type CarryProbe,
  claudeProjectDirName,
  githubRepository,
  planCarry,
  referencedPaths,
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

describe("referencedPaths", () => {
  const scope = { home: "/Users/me", cwd: "/Users/me/.t3/worktrees/repo/wt" };
  const toolUse = (name: string, input: unknown) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input }] },
    });
  const toolResult = (content: unknown) =>
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t", content }] },
    });

  it("finds outside paths in tool inputs, tool results and saved outputs", () => {
    const transcripts = [
      [
        toolUse("Write", { file_path: "/tmp/astra.md", content: "see /tmp/ledger/ledger.tsv." }),
        toolUse("Edit", { file_path: "/Users/me/parity-scratch/first-principles/design.md" }),
        toolUse("Bash", {
          command:
            "cat > ~/parity-scratch/e0/acting.txt <<'EOF'\nrun $HOME/notes/a.md\nEOF\nsource /tmp/mind-twin.env && ls /tmp/measure/*.md > /private/tmp/out/list",
        }),
        toolUse("Read", { file_path: "/Users/me/.t3/worktrees/repo/wt/src/index.ts" }),
        toolUse("Bash", {
          command:
            "ls ~/.claude_work/projects ~/.codex/sessions ~/Library/Keychains /tmp/claude-501/x",
        }),
        JSON.stringify({ type: "user", message: { content: "my own note at /tmp/typed.md" } }),
      ].join("\n"),
      toolResult([{ type: "text", text: "wrote /tmp/r5e6/report.json" }]),
    ];
    assert.deepStrictEqual(
      referencedPaths(
        { transcripts, outputs: ["saved ${HOME}/out.txt and https://x.io/tmp/no"] },
        scope,
      ),
      {
        paths: [
          "/Users/me/notes/a.md",
          "/Users/me/out.txt",
          "/Users/me/parity-scratch/e0/acting.txt",
          "/Users/me/parity-scratch/first-principles/design.md",
          "/tmp/astra.md",
          "/tmp/ledger/ledger.tsv",
          "/tmp/measure",
          "/tmp/mind-twin.env",
          "/tmp/out/list",
          "/tmp/r5e6/report.json",
        ],
        toolConfig: ["/Users/me/.claude_work", "/Users/me/.codex", "/Users/me/Library"],
      },
    );
  });
});

describe("planCarry", () => {
  const MB = 1024 ** 2;
  const disk: Record<string, CarryProbe> = {
    "/Users/me/scratch": { kind: "tree", bytes: 9000 * MB, holdsRepo: true },
    "/Users/me/scratch/notes": { kind: "tree", bytes: 2 * MB, holdsRepo: false },
    "/Users/me/scratch/notes/a.md": { kind: "tree", bytes: 1 * MB, holdsRepo: false },
    "/Users/me/scratch/wt/src/a.ts": {
      kind: "repo",
      root: "/Users/me/scratch/wt",
      remote: "git@github.com:o/r.git",
    },
    "/Users/me/scratch/wt/README.md": {
      kind: "repo",
      root: "/Users/me/scratch/wt",
      remote: "git@github.com:o/r.git",
    },
    "/tmp/big": { kind: "tree", bytes: 1500 * MB, holdsRepo: false },
    "/tmp/big/summary.md": { kind: "tree", bytes: 1 * MB, holdsRepo: false },
    "/tmp/gone": { kind: "missing" },
    "/tmp/gone/x": { kind: "missing" },
    "/tmp/measure": { kind: "tree", bytes: 700 * MB, holdsRepo: false },
    "/tmp/proto": { kind: "tree", bytes: 600 * MB, holdsRepo: false },
    "/tmp/twin.env": { kind: "tree", bytes: 1, holdsRepo: false },
  };

  it("carries the smallest whole items within the caps and falls back inside oversized ones", () => {
    const plan = planCarry(Object.keys(disk).toSorted(), (path) => disk[path]!, {
      itemBytes: 1024 * MB,
      totalBytes: 1024 * MB,
    });
    assert.deepStrictEqual(plan, {
      carry: [
        { path: "/Users/me/scratch/notes", bytes: 2 * MB },
        { path: "/tmp/big/summary.md", bytes: 1 * MB },
        { path: "/tmp/proto", bytes: 600 * MB },
        { path: "/tmp/twin.env", bytes: 1 },
      ],
      skipped: [
        { path: "/Users/me/scratch", reason: "holds a git repo" },
        {
          path: "/Users/me/scratch/wt",
          reason: "git repo (code is on GitHub/clone again): git@github.com:o/r.git",
        },
        { path: "/tmp/big", reason: "over the 1.0 GB item cap" },
        { path: "/tmp/measure", reason: "over the 1.0 GB total cap" },
      ],
    });
  });
});
