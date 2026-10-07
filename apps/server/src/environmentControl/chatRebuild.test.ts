// @effect-diagnostics nodeBuiltinImport:off - these tests drive disposable Git repositories and Python.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { CloudBackupManifest } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeBoxRestore, planRebuild } from "./chatRebuild.ts";
import { git, type Cleanups } from "./guestTestFixture.ts";
import type { RemotePreparationPort } from "./remotePreparation.ts";
import { backUpWorkspace } from "./workspaceBackup.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Stands in for the AWS CLI: `s3 cp s3://<key> <file>` copies from a local bucket. */
const fakeAws = String.raw`#!/usr/bin/env python3
import os, pathlib, shutil, sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
assert args[:2] == ['s3', 'cp'], args
source = pathlib.Path(os.environ['FAKE_BUCKET']) / args[2].removeprefix('s3://')
if not source.is_file():
    sys.stderr.write('NoSuchKey\n')
    sys.exit(1)
shutil.copyfile(source, args[3])
`;

const OLD_WORKSPACE = "/home/user/.t3-provision/workspace";
const URI = "s3://bucket/t3-agents/child/backups/latest/";

/**
 * An old box whose unsaved work went to a bundle, its backup in a local bucket, and a fresh box
 * cloned from the same origin on `main`, with an AWS CLI that reads the bucket.
 */
async function rebuildFixture() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-rebuild-")),
  );
  cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
  const origin = NodePath.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const oldRoot = NodePath.join(base, "old");
  const oldWorkspace = NodePath.join(oldRoot, "workspace");
  await NodeFSP.mkdir(oldRoot);
  git(oldRoot, "clone", "-q", origin, oldWorkspace);
  await NodeFSP.writeFile(NodePath.join(oldWorkspace, "README.md"), "base\n");
  git(oldWorkspace, "add", ".");
  git(oldWorkspace, "commit", "-qm", "base");
  git(oldWorkspace, "push", "-q", "origin", "HEAD:main");
  await NodeFSP.writeFile(NodePath.join(oldWorkspace, "notes.txt"), "unsaved on the old box\n");

  const prefix = NodePath.join(base, "bucket", "bucket", "t3-agents", "child", "backups", "latest");
  await NodeFSP.mkdir(NodePath.join(prefix, "claudeAgent", "projects", "-w"), { recursive: true });
  const saved = await backUpWorkspace(
    {
      executePython: ({ script, stdin }) => runPython(script, stdin, process.env),
    },
    {
      root: oldRoot,
      branch: "lease-1",
      target: { kind: "bundle", path: NodePath.join(prefix, "work.bundle") },
    },
  );
  if (saved.kind !== "saved") throw new Error(`the old box's backup was ${saved.kind}`);
  await NodeFSP.writeFile(
    NodePath.join(prefix, "claudeAgent", "projects", "-w", "s-1.jsonl"),
    `{"cwd":"${OLD_WORKSPACE}","message":"edit ${OLD_WORKSPACE}/notes.txt"}\n{"cwd":"${OLD_WORKSPACE}/src"}\n`,
  );
  const manifest: CloudBackupManifest = {
    version: 1,
    environmentId: "child",
    leaseId: "lease-1",
    account: "claude-a",
    threadId: "thread",
    title: "Fix the login page",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-1" },
    workspace: OLD_WORKSPACE,
    repository: "https://github.com/acme/app.git",
    branch: "main",
    head: null,
    branchOnOrigin: true,
    defaultBranch: "main",
    backupBranches: ["t3-backup/lease-1"],
    bundle: "work.bundle",
    sessions: [
      {
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        nativeId: "s-1",
        files: ["claudeAgent/projects/-w/s-1.jsonl"],
      },
    ],
  };
  await NodeFSP.writeFile(NodePath.join(prefix, "manifest.json"), JSON.stringify(manifest));

  const root = NodePath.join(base, "new");
  const workspace = NodePath.join(root, "workspace");
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(NodePath.join(home, ".t3", "userdata"), { recursive: true });
  git(root, "clone", "-q", origin, workspace);
  const bin = NodePath.join(base, "bin");
  await NodeFSP.mkdir(bin);
  await NodeFSP.writeFile(NodePath.join(bin, "aws"), fakeAws, { mode: 0o755 });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    T3CODE_HOME: NodePath.join(home, ".t3"),
    FAKE_BUCKET: NodePath.join(base, "bucket"),
  };
  const port: RemotePreparationPort = {
    executePython: ({ script, stdin }) => runPython(script, stdin, env),
  };
  return { root, workspace, home, port, manifest };
}

/** Runs a guest script with exactly `env`, so nothing reaches this machine's own agent homes. */
function runPython(script: string, stdin: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
    const child = NodeChildProcess.spawn("python3", ["-c", script], {
      env,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
    child.once("error", reject);
    child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
    child.stdin.end(stdin);
  });
}

describe("a fresh box restoring a chat's backup", () => {
  it("reads the manifest, lands on the backup branch with the old box's work, and stages the session at its new path", async () => {
    const f = await rebuildFixture();
    const restore = makeBoxRestore(f.port, { root: f.root, uri: URI });
    const manifest = await restore.readManifest();
    expect(manifest).toEqual(f.manifest);

    const plan = planRebuild(manifest, URI);
    expect({ branch: plan.branch, checkout: plan.checkout, bundle: plan.bundle }).toEqual({
      branch: "main",
      checkout: "t3-backup/lease-1",
      bundle: "work.bundle",
    });
    const files = await restore.restoreWork(plan, manifest.workspace);
    expect(git(f.workspace, "symbolic-ref", "--short", "HEAD")).toBe("t3-backup/lease-1");
    expect(await NodeFSP.readFile(NodePath.join(f.workspace, "notes.txt"), "utf8")).toBe(
      "unsaved on the old box\n",
    );
    const claude = NodePath.join(f.home, ".claude", "projects");
    expect(files).toEqual({
      kind: "restored",
      staged: NodePath.join(claude, "t3-move-chat-staging", "s-1.jsonl"),
      final: NodePath.join(claude, f.workspace.replace(/[^a-zA-Z0-9]/g, "-"), "s-1.jsonl"),
      moved: NodePath.join(f.root, "backup", "restored-s-1.jsonl"),
    });
    expect(await NodeFSP.readFile(files.staged, "utf8")).toBe(
      `{"cwd":"${f.workspace}","message":"edit ${OLD_WORKSPACE}/notes.txt"}\n{"cwd":"${f.workspace}/src"}\n`,
    );

    await restore.unstage(files.staged);
    await restore.swap("s-1", files);
    expect(
      await NodeFSP.access(files.staged).then(
        () => "kept",
        () => "removed",
      ),
    ).toBe("removed");
    expect(await NodeFSP.readFile(files.final, "utf8")).toBe(
      await NodeFSP.readFile(files.moved, "utf8"),
    );
  });

  it("fails with the reason when the backup is gone", async () => {
    const f = await rebuildFixture();
    const restore = makeBoxRestore(f.port, { root: f.root, uri: "s3://bucket/elsewhere/" });
    await expect(restore.readManifest()).rejects.toThrow(
      "The backup has no readable manifest.json: NoSuchKey",
    );
  });
});
