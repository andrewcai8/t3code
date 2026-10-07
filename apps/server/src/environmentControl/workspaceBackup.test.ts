// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests drive disposable Git repositories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { git, localPort, type Cleanups } from "./guestTestFixture.ts";
import { backUpWorkspace } from "./workspaceBackup.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A chat root whose workspace clones a local bare `origin`, as a box's checkout clones GitHub. */
async function chatRoot() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backup-")),
  );
  cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
  const origin = NodePath.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const root = NodePath.join(base, "root");
  const workspace = NodePath.join(root, "workspace");
  await NodeFSP.mkdir(root);
  git(root, "clone", "-q", origin, workspace);
  await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "base\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "base");
  git(workspace, "push", "-q", "origin", "HEAD:main");
  return { root, workspace, origin };
}

const backupRefs = (origin: string) =>
  git(origin, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/t3-backup/");

describe("backUpWorkspace", () => {
  it("finds nothing to save in a clean clone", async () => {
    const { root, origin } = await chatRoot();
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toEqual({
      kind: "clean",
    });
    expect(backupRefs(origin)).toBe("");
  });

  it("finds nothing to save in a chat that never cloned", async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backup-"));
    cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
    expect(
      await backUpWorkspace(localPort, {
        root: base,
        branch: "lease-1",
        target: { kind: "origin" },
      }),
    ).toEqual({ kind: "clean" });
  });

  it("pushes uncommitted, untracked and unpushed work of every tree to backup branches", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "committed.txt"), "not pushed\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "local only");
    await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "edited\n");
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    const tree = NodePath.join(root, "home", ".t3", "worktrees", "feature");
    git(workspace, "worktree", "add", "-q", "-b", "feature", tree);
    await NodeFSP.writeFile(NodePath.join(tree, "feature.txt"), "feature work\n");
    const realIndex = await NodeFSP.readFile(NodePath.join(workspace, ".git", "index"));

    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({
      kind: "saved",
      branches: [
        "t3-backup/lease-1",
        "t3-backup/lease-1-1",
        "t3-backup/lease-1-branch-0",
        "t3-backup/lease-1-branch-1",
      ],
    });
    expect(git(origin, "show", "t3-backup/lease-1:README.md")).toBe("edited");
    expect(git(origin, "show", "t3-backup/lease-1:untracked.txt")).toBe("new");
    expect(git(origin, "show", "t3-backup/lease-1:committed.txt")).toBe("not pushed");
    expect(git(origin, "show", "t3-backup/lease-1-1:feature.txt")).toBe("feature work");
    expect(git(workspace, "status", "--porcelain")).toBe("M README.md\n?? untracked.txt");
    expect(await NodeFSP.readFile(NodePath.join(workspace, ".git", "index"))).toEqual(realIndex);
  });

  it("pushes the unpushed tip of a branch no tree has checked out", async () => {
    const { root, workspace, origin } = await chatRoot();
    git(workspace, "switch", "-qc", "feature-x");
    await NodeFSP.writeFile(NodePath.join(workspace, "feature.txt"), "feature work\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "feature work");
    const tip = git(workspace, "rev-parse", "HEAD");
    git(workspace, "switch", "-q", "main");

    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({
      kind: "saved",
      branches: ["t3-backup/lease-1-branch-0"],
    });
    expect(backupRefs(origin)).toBe(`refs/heads/t3-backup/lease-1-branch-0 ${tip}`);
  });

  it("leaves a real index alone even when its file times are stale", async () => {
    const { root, workspace } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "base\n");
    await NodeFSP.utimes(
      NodePath.join(workspace, "README.md"),
      new Date(),
      new Date(Date.now() + 60_000),
    );
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    const realIndex = await NodeFSP.readFile(NodePath.join(workspace, ".git", "index"));
    await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } });
    expect(await NodeFSP.readFile(NodePath.join(workspace, ".git", "index"))).toEqual(realIndex);
  });

  it("pushes a worktree that lives outside the chat's root", async () => {
    const { root, workspace, origin } = await chatRoot();
    const outside = NodePath.join(NodePath.dirname(root), "outside");
    git(workspace, "worktree", "add", "-q", "-b", "outside", outside);
    await NodeFSP.writeFile(NodePath.join(outside, "review.md"), "notes\n");
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({ kind: "saved", branches: ["t3-backup/lease-1-1"] });
    expect(git(origin, "show", "t3-backup/lease-1-1:review.md")).toBe("notes");
  });

  it("reports changes in a tree with submodules", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(
      NodePath.join(workspace, ".gitmodules"),
      '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n',
    );
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toEqual({
      kind: "unsaved",
      reason: "A submodule's changes cannot be backed up.",
    });
    expect(backupRefs(origin)).toBe("");
  });

  it("pushes each stash entry", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "stashed\n");
    git(workspace, "stash", "-q");
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({
      kind: "saved",
      branches: ["t3-backup/lease-1-stash-0"],
    });
    expect(git(origin, "show", "t3-backup/lease-1-stash-0:README.md")).toBe("stashed");
  });

  it("converges on the same branches when run again", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } });
    const first = backupRefs(origin);
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({
      kind: "saved",
      branches: ["t3-backup/lease-1"],
    });
    expect(backupRefs(origin)).toBe(first);
  });

  it("skips the push when the work is what the last backup saved, and pushes a change", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    const first = await backUpWorkspace(localPort, {
      root,
      branch: "lease-1",
      target: { kind: "origin" },
    });
    if (first.kind !== "saved") throw new Error(`first backup was ${first.kind}`);
    git(origin, "update-ref", "-d", "refs/heads/t3-backup/lease-1");

    expect(
      await backUpWorkspace(localPort, {
        root,
        branch: "lease-1",
        target: { kind: "origin" },
        previous: first.fingerprint,
      }),
    ).toEqual({ kind: "unchanged" });
    expect(backupRefs(origin)).toBe("");

    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "changed\n");
    expect(
      await backUpWorkspace(localPort, {
        root,
        branch: "lease-1",
        target: { kind: "origin" },
        previous: first.fingerprint,
      }),
    ).toMatchObject({ kind: "saved", branches: ["t3-backup/lease-1"] });
    expect(git(origin, "show", "t3-backup/lease-1:untracked.txt")).toBe("changed");
  });

  it("still backs up a commit that only an earlier backup branch holds", async () => {
    const { root, workspace } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "committed.txt"), "not pushed\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "local only");
    await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } });
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({
      kind: "saved",
      branches: ["t3-backup/lease-1", "t3-backup/lease-1-branch-0"],
    });
  });

  it("removes branches an earlier backup made that hold nothing now", async () => {
    const { root, workspace, origin } = await chatRoot();
    git(workspace, "switch", "-qc", "feature-x");
    await NodeFSP.writeFile(NodePath.join(workspace, "feature.txt"), "feature work\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "feature work");
    git(workspace, "switch", "-q", "main");
    git(origin, "branch", "t3-backup/lease-10", "main");
    await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } });
    expect(
      backupRefs(origin)
        .split("\n")
        .map((line) => line.split(" ")[0]),
    ).toEqual(["refs/heads/t3-backup/lease-1-branch-0", "refs/heads/t3-backup/lease-10"]);

    git(workspace, "push", "-q", "origin", "feature-x");
    await NodeFSP.writeFile(NodePath.join(workspace, "notes.txt"), "unsaved\n");
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toMatchObject({ kind: "saved", branches: ["t3-backup/lease-1"] });
    expect(
      backupRefs(origin)
        .split("\n")
        .map((line) => line.split(" ")[0]),
    ).toEqual(["refs/heads/t3-backup/lease-1", "refs/heads/t3-backup/lease-10"]);

    await NodeFSP.rm(NodePath.join(workspace, "notes.txt"));
    expect(
      await backUpWorkspace(localPort, {
        root,
        branch: "lease-1",
        target: { kind: "origin" },
        stale: true,
      }),
    ).toEqual({ kind: "clean" });
    expect(backupRefs(origin)).toBe(
      `refs/heads/t3-backup/lease-10 ${git(origin, "rev-parse", "main")}`,
    );
  });

  it("keeps the work in a bundle instead of on origin, holding only what origin lacks", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "committed.txt"), "not pushed\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "local only");
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    const bundle = NodePath.join(root, "backup", "work.bundle");
    const saved = await backUpWorkspace(localPort, {
      root,
      branch: "lease-1",
      target: { kind: "bundle", path: bundle },
    });
    expect(saved).toMatchObject({
      kind: "saved",
      branches: ["t3-backup/lease-1", "t3-backup/lease-1-branch-0"],
      bundle,
    });
    expect(backupRefs(origin)).toBe("");
    expect(git(workspace, "for-each-ref", "refs/t3-bundle/")).toBe("");

    const restored = NodePath.join(NodePath.dirname(root), "restored");
    git(NodePath.dirname(root), "clone", "-q", origin, restored);
    git(restored, "fetch", "-q", bundle, "refs/t3-bundle/*:refs/heads/*");
    expect(git(restored, "show", "t3-backup/lease-1:untracked.txt")).toBe("new");
    expect(git(restored, "show", "t3-backup/lease-1:committed.txt")).toBe("not pushed");

    await NodeFSP.rm(NodePath.join(workspace, "untracked.txt"));
    git(workspace, "reset", "-q", "--hard", "origin/main");
    expect(
      await backUpWorkspace(localPort, {
        root,
        branch: "lease-1",
        target: { kind: "bundle", path: bundle },
      }),
    ).toEqual({ kind: "clean" });
    expect(
      await NodeFSP.access(bundle).then(
        () => "kept",
        () => "removed",
      ),
    ).toBe("removed");
  });

  it("reports pending work it may not push, and pushes nothing", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    expect(
      await backUpWorkspace(localPort, {
        root,
        branch: "lease-1",
        target: { kind: "none", reason: "No token." },
      }),
    ).toEqual({
      kind: "unsaved",
      reason: "No token.",
    });
    expect(backupRefs(origin)).toBe("");
  });

  it("reports pending work in a checkout with no origin", async () => {
    const { root, workspace } = await chatRoot();
    git(workspace, "remote", "remove", "origin");
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toEqual({
      kind: "unsaved",
      reason: "The checkout has no origin remote to push to.",
    });
  });

  it("reports a workspace that is not a git repository", async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-backup-"));
    cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
    await NodeFSP.mkdir(NodePath.join(base, "workspace"));
    await NodeFSP.writeFile(NodePath.join(base, "workspace", "notes.txt"), "loose\n");
    expect(
      await backUpWorkspace(localPort, {
        root: base,
        branch: "lease-1",
        target: { kind: "origin" },
      }),
    ).toEqual({ kind: "unsaved", reason: "The workspace is not a git repository." });
  });

  it("reports a push the remote refuses", async () => {
    const { root, workspace, origin } = await chatRoot();
    await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "new\n");
    await NodeFSP.writeFile(NodePath.join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    expect(
      await backUpWorkspace(localPort, { root, branch: "lease-1", target: { kind: "origin" } }),
    ).toEqual({
      kind: "unsaved",
      reason: "The backup push failed.",
    });
  });

  it("reports a guest that could not run the backup", async () => {
    expect(
      await backUpWorkspace(
        { executePython: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }) },
        { root: "/nowhere", branch: "lease-1", target: { kind: "origin" } },
      ),
    ).toEqual({ kind: "unsaved", reason: "The backup did not finish." });
  });
});
