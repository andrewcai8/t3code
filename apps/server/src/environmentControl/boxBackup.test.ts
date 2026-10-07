// @effect-diagnostics nodeBuiltinImport:off globalDate:off - these tests drive disposable Git repositories, SQLite files and Python.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CloudBackupManifest } from "@t3tools/contracts";
import { backUpBox, backUpSessions, workTarget } from "./boxBackup.ts";
import { git, type Cleanups } from "./guestTestFixture.ts";
import type { RemotePreparationPort } from "./remotePreparation.ts";
import * as Schema from "effect/Schema";

const cleanups: Cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Stands in for the AWS CLI: `s3 sync --delete <dir> s3://<key>` mirrors the dir under `bucket`. */
const fakeAws = String.raw`#!/usr/bin/env python3
import os, pathlib, shutil, sys
args = [a for a in sys.argv[1:] if not a.startswith('--')]
assert args[:2] == ['s3', 'sync'], args
source, uri = args[2], args[3]
bucket = pathlib.Path(os.environ['FAKE_BUCKET'])
with open(bucket.parent / 'aws-calls', 'a') as calls:
    calls.write(uri + ' ' + os.environ.get('AWS_ACCESS_KEY_ID', '-') + '\n')
target = bucket / uri.removeprefix('s3://')
shutil.rmtree(target, ignore_errors=True)
shutil.copytree(source, target)
`;

/**
 * A box's provision root: a workspace cloned from a local origin, the T3 database with the owner
 * chat and another chat, each with a Claude and a Codex session, and an AWS CLI that writes to a
 * local bucket.
 */
async function box() {
  const base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-box-backup-")),
  );
  cleanups.push(() => NodeFSP.rm(base, { recursive: true, force: true }));
  const origin = NodePath.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const root = NodePath.join(base, "root");
  const workspace = NodePath.join(root, "workspace");
  const home = NodePath.join(root, "home");
  await NodeFSP.mkdir(NodePath.join(home, ".t3", "userdata"), { recursive: true });
  git(root, "clone", "-q", origin, workspace);
  await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "base\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "base");
  git(workspace, "push", "-q", "origin", "HEAD:main");
  git(workspace, "remote", "set-head", "origin", "main");

  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, ".t3", "userdata", "statev2.sqlite"));
  db.exec(`
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT, ordinal INTEGER, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, provider_instance_id TEXT, last_run_ordinal INTEGER, payload_json TEXT);
  `);
  const thread = db.prepare(
    "INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?, ?, ?)",
  );
  const native = (driver: string, nativeId: string) =>
    JSON.stringify({ driver, nativeThreadRef: { driver, nativeId, strength: "strong" } });
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run(
    "owner-thread",
    "Fix the login page",
  );
  db.prepare("INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, ?, ?)").run(
    "run-2",
    "owner-thread",
    2,
    JSON.stringify({ modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-1" } }),
  );
  thread.run(
    "pt-claude",
    "owner-thread",
    "claudeAgent",
    "claudeAgent",
    1,
    native("claudeAgent", "s-owner"),
  );
  thread.run("pt-codex", "owner-thread", "codex", "codex", 2, native("codex", "c-owner"));
  thread.run(
    "pt-other",
    "other-thread",
    "claudeAgent",
    "claudeAgent",
    1,
    native("claudeAgent", "s-other"),
  );
  db.close();

  const project = NodePath.join(home, ".claude", "projects", "-workspace");
  await NodeFSP.mkdir(NodePath.join(project, "s-owner", "subagents"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(project, "s-owner.jsonl"), '{"owner":1}\n');
  await NodeFSP.writeFile(NodePath.join(project, "s-owner", "subagents", "a.jsonl"), "{}\n");
  await NodeFSP.writeFile(NodePath.join(project, "s-other.jsonl"), '{"other":1}\n');
  const day = NodePath.join(home, ".codex", "sessions", "2026", "10", "06");
  await NodeFSP.mkdir(day, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(day, "rollout-2026-10-06T10-00-00-c-owner.jsonl"), "{}\n");
  await NodeFSP.writeFile(NodePath.join(day, "rollout-2026-10-06T11-00-00-c-other.jsonl"), "{}\n");

  // As a server that saved its settings keeps it: the value in its secret store, not the file.
  await NodeFSP.writeFile(
    NodePath.join(home, ".t3", "userdata", "settings.json"),
    JSON.stringify({
      providerInstances: {
        claudeAgent: {
          environment: [
            { name: "AWS_ACCESS_KEY_ID", value: "", sensitive: true, valueRedacted: true },
          ],
        },
      },
    }),
  );
  const secrets = NodePath.join(home, ".t3", "userdata", "secrets");
  await NodeFSP.mkdir(secrets);
  const secretName = `provider-env-${Buffer.from("claudeAgent").toString("base64url")}-${Buffer.from("AWS_ACCESS_KEY_ID").toString("base64url")}`;
  await NodeFSP.writeFile(NodePath.join(secrets, `${secretName}.bin`), "AKIA-FROM-SECRET-STORE");
  const bin = NodePath.join(base, "bin");
  await NodeFSP.mkdir(bin);
  await NodeFSP.writeFile(NodePath.join(bin, "aws"), fakeAws, { mode: 0o755 });
  const bucket = NodePath.join(base, "bucket");
  const port: RemotePreparationPort = {
    executePython: ({ script, stdin }) =>
      new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn("python3", ["-c", script], {
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: home,
            T3CODE_HOME: NodePath.join(home, ".t3"),
            FAKE_BUCKET: bucket,
          },
        });
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
        child.once("error", reject);
        child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
        child.stdin.end(stdin);
      }),
  };
  const uploaded = async () => {
    const files: Array<string> = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
        const path = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else files.push(NodePath.relative(bucket, path));
      }
    };
    await walk(bucket);
    return files.sort();
  };
  const awsCallLines = async () =>
    (await NodeFSP.readFile(NodePath.join(base, "aws-calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
  const awsCalls = async () => (await awsCallLines()).length;
  return { root, workspace, origin, project, bucket, port, uploaded, awsCalls, awsCallLines };
}

const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(CloudBackupManifest));
const URI = "s3://bucket/t3-agents/child/backups/latest/";
const chat = {
  environmentId: "child",
  leaseId: "lease-1",
  account: "claude-a",
  threadId: "owner-thread",
};

describe("backUpSessions", () => {
  it("uploads only the owner chat's sessions, with a manifest restore reads", async () => {
    const f = await box();
    expect(
      await backUpSessions(f.port, {
        root: f.root,
        uri: URI,
        chat,
        branches: ["t3-backup/lease-1"],
        timeoutSeconds: 30,
      }),
    ).toMatchObject({
      kind: "saved",
      files: [
        "claudeAgent/projects/-workspace/s-owner.jsonl",
        "claudeAgent/projects/-workspace/s-owner/subagents/a.jsonl",
        "codex/sessions/2026/10/06/rollout-2026-10-06T10-00-00-c-owner.jsonl",
      ],
    });
    const prefix = "bucket/t3-agents/child/backups/latest";
    expect(await f.uploaded()).toEqual([
      `${prefix}/claudeAgent/projects/-workspace/s-owner.jsonl`,
      `${prefix}/claudeAgent/projects/-workspace/s-owner/subagents/a.jsonl`,
      `${prefix}/codex/sessions/2026/10/06/rollout-2026-10-06T10-00-00-c-owner.jsonl`,
      `${prefix}/manifest.json`,
    ]);
    const manifest = decodeManifest(
      await NodeFSP.readFile(NodePath.join(f.bucket, prefix, "manifest.json"), "utf8"),
    );
    expect(manifest).toEqual({
      version: 1,
      ...chat,
      title: "Fix the login page",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-1" },
      workspace: f.workspace,
      repository: f.origin,
      branch: "main",
      head: git(f.workspace, "rev-parse", "HEAD"),
      branchOnOrigin: true,
      defaultBranch: "main",
      backupBranches: ["t3-backup/lease-1"],
      bundle: null,
      sessions: [
        {
          driver: "claudeAgent",
          instanceId: "claudeAgent",
          nativeId: "s-owner",
          files: [
            "claudeAgent/projects/-workspace/s-owner.jsonl",
            "claudeAgent/projects/-workspace/s-owner/subagents/a.jsonl",
          ],
        },
        {
          driver: "codex",
          instanceId: "codex",
          nativeId: "c-owner",
          files: ["codex/sessions/2026/10/06/rollout-2026-10-06T10-00-00-c-owner.jsonl"],
        },
      ],
    });
  });

  it("uploads with the AWS key the box's server keeps in its secret store", async () => {
    const f = await box();
    await backUpSessions(f.port, {
      root: f.root,
      uri: URI,
      chat,
      branches: [],
      timeoutSeconds: 30,
    });
    expect(await f.awsCallLines()).toEqual([`${URI} AKIA-FROM-SECRET-STORE`]);
  });

  it("skips an unchanged chat, and uploads again once its transcript grows", async () => {
    const f = await box();
    const input = { root: f.root, uri: URI, chat, branches: [], timeoutSeconds: 30 };
    const first = await backUpSessions(f.port, input);
    if (first.kind !== "saved") throw new Error(`first backup was ${first.kind}`);
    expect(await backUpSessions(f.port, { ...input, previous: first.fingerprint })).toEqual({
      kind: "unchanged",
    });
    expect(await f.awsCalls()).toBe(1);

    await NodeFSP.appendFile(NodePath.join(f.project, "s-owner.jsonl"), '{"turn":2}\n');
    expect(await backUpSessions(f.port, { ...input, previous: first.fingerprint })).toMatchObject({
      kind: "saved",
    });
    expect(await f.awsCalls()).toBe(2);
  });
});

describe("workTarget", () => {
  it("pushes only to a private origin, and otherwise keeps the work in the private bucket", () => {
    expect(workTarget({ originIsPrivate: true, token: "t", bundlePath: "/b" })).toEqual({
      kind: "origin",
      token: "t",
    });
    expect(workTarget({ originIsPrivate: false, token: "t", bundlePath: "/b" })).toEqual({
      kind: "bundle",
      path: "/b",
    });
    expect(workTarget({ originIsPrivate: false, token: "t", bundlePath: undefined })).toEqual({
      kind: "none",
      reason: "The repository may be public, and this host has no private bucket for the work.",
    });
  });
});

describe("backUpBox", () => {
  it("records the work's branches and the sessions, then leaves an unchanged box's record alone", async () => {
    const f = await box();
    await NodeFSP.writeFile(NodePath.join(f.workspace, "notes.txt"), "unsaved\n");
    const input = {
      root: f.root,
      leaseId: "lease-1",
      target: { kind: "origin" as const },
      sessions: { uri: URI, environmentId: "child", account: "claude-a", threadId: "owner-thread" },
      now: "2026-10-06T12:00:00.000Z",
      deadline: Date.now() + 60_000,
    };
    const first = await backUpBox(f.port, { ...input, previous: undefined });
    expect(first).toMatchObject({
      backup: { at: "2026-10-06T12:00:00.000Z", branches: ["t3-backup/lease-1"], sessionsUri: URI },
      problems: [],
    });
    expect(git(f.origin, "show", "t3-backup/lease-1:notes.txt")).toBe("unsaved");

    const again = await backUpBox(f.port, {
      ...input,
      previous: first.backup,
      now: "2026-10-06T13:00:00.000Z",
    });
    expect(again).toEqual({ backup: first.backup, problems: [] });
    expect(await f.awsCalls()).toBe(1);
  });

  it("stores a public repository's unsaved work as a bundle beside the sessions, never on origin", async () => {
    const f = await box();
    await NodeFSP.writeFile(NodePath.join(f.workspace, "notes.txt"), "unsaved\n");
    const result = await backUpBox(f.port, {
      root: f.root,
      leaseId: "lease-1",
      target: { kind: "bundle", path: NodePath.join(f.root, "backup", "work.bundle") },
      sessions: { uri: URI, environmentId: "child", account: "claude-a", threadId: "owner-thread" },
      previous: undefined,
      now: "2026-10-06T12:00:00.000Z",
      deadline: Date.now() + 60_000,
    });
    expect(result).toMatchObject({ backup: { branches: ["t3-backup/lease-1"] }, problems: [] });
    expect(git(f.origin, "for-each-ref", "refs/heads/t3-backup/")).toBe("");
    const prefix = NodePath.join(f.bucket, "bucket/t3-agents/child/backups/latest");
    expect(
      decodeManifest(await NodeFSP.readFile(NodePath.join(prefix, "manifest.json"), "utf8")),
    ).toMatchObject({ backupBranches: ["t3-backup/lease-1"], bundle: "work.bundle" });
    const restored = NodePath.join(f.root, "..", "restored");
    git(f.root, "clone", "-q", f.origin, restored);
    git(
      restored,
      "fetch",
      "-q",
      NodePath.join(prefix, "work.bundle"),
      "refs/t3-bundle/*:refs/heads/*",
    );
    expect(git(restored, "show", "t3-backup/lease-1:notes.txt")).toBe("unsaved");
  });

  it("keeps the last record's sessions when the upload fails, and says why", async () => {
    const f = await box();
    const previous = {
      at: "2026-10-06T12:00:00.000Z",
      branches: [],
      sessionsUri: URI,
      sessionsFingerprint: "older",
    };
    await NodeFSP.rm(NodePath.join(f.root, "home", ".t3", "userdata", "statev2.sqlite"));
    expect(
      await backUpBox(f.port, {
        root: f.root,
        leaseId: "lease-1",
        target: { kind: "origin" as const },
        sessions: {
          uri: URI,
          environmentId: "child",
          account: "claude-a",
          threadId: "owner-thread",
        },
        previous,
        now: "2026-10-06T13:00:00.000Z",
        deadline: Date.now() + 60_000,
      }),
    ).toEqual({ backup: previous, problems: ["The chat's database could not be read."] });
  });
});
