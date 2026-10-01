// @effect-diagnostics nodeBuiltinImport:off - these tests drive disposable Python, Git, SQLite and HTTP processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DERIVED_HOME_PATHS,
  adoptChatTemplate,
  restoreChat,
  saveChat,
  scrubChatRoot,
  sealChatTemplate,
} from "./guestChatState.ts";
import {
  artifactStore as makeArtifactStore,
  exists,
  git,
  localPort,
  sha256,
  statusLines,
  world as makeWorld,
  type Cleanups,
  type World,
} from "./guestTestFixture.ts";
import { prepareRemoteHost } from "./remotePreparation.ts";

const cleanups: Cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const world = () => makeWorld(cleanups);
const artifactStore = () => makeArtifactStore(cleanups);

function templateIdentity(w: World, key = "prepare-v1") {
  return {
    instanceId: w.instance(),
    mount: w.mount,
    root: w.root,
    repository: w.origin,
    key,
    runtimeSha256: w.runtimeSha256,
    maxAgeSeconds: 86_400,
  };
}

/** A sqlite database in WAL mode whose writer stays connected, like the guest T3 server. */
function openDatabaseWriter(path: string, rows: number) {
  const child = NodeChildProcess.spawn(
    "python3",
    [
      "-c",
      `import sqlite3,sys,time
db=sqlite3.connect(sys.argv[1]); db.execute('pragma journal_mode=wal'); db.execute('pragma wal_autocheckpoint=0')
db.execute('create table if not exists events(id integer primary key, body text)')
for i in range(${rows}): db.execute('insert into events(body) values (?)', ('event %d' % i,))
db.commit(); print('ready', flush=True); time.sleep(600)`,
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanups.push(() => void child.kill("SIGKILL"));
  return new Promise<() => void>((resolve) =>
    child.stdout.once("data", () => resolve(() => child.kill("SIGKILL"))),
  );
}

function sqlite(path: string, query: string) {
  return NodeChildProcess.execFileSync(
    "python3",
    [
      "-c",
      "import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchall())",
      path,
      query,
    ],
    { encoding: "utf8" },
  ).trim();
}

/** What an agent leaves behind in a turn, across every kind of state the chat owns. */
async function doChatWork(w: World) {
  const workspace = NodePath.join(w.root, "workspace");
  const home = NodePath.join(w.root, "home");
  await NodeFSP.writeFile(NodePath.join(workspace, "feature.txt"), "committed by the agent\n");
  git(workspace, "add", "feature.txt");
  git(workspace, "commit", "-qm", "agent commit");
  git(workspace, "update-ref", "refs/t3/checkpoints/thread-1/turn/1", "HEAD");
  await NodeFSP.writeFile(NodePath.join(workspace, "stashed-first.txt"), "first\n");
  git(workspace, "add", "stashed-first.txt");
  git(workspace, "stash", "push", "-q", "-m", "first stash");
  await NodeFSP.appendFile(NodePath.join(workspace, "README.md"), "stashed second\n");
  git(workspace, "stash", "push", "-q", "-m", "second stash");
  await NodeFSP.appendFile(NodePath.join(workspace, "staged.txt"), "staged\n");
  git(workspace, "add", "staged.txt");
  await NodeFSP.appendFile(NodePath.join(workspace, "README.md"), "unstaged\n");
  await NodeFSP.rm(NodePath.join(workspace, "remove-me.txt"));
  await NodeFSP.writeFile(NodePath.join(workspace, "untracked.txt"), "untracked\n");
  await NodeFSP.mkdir(NodePath.join(workspace, "notes"));
  await NodeFSP.symlink("../README.md", NodePath.join(workspace, "notes", "readme-link"));
  await NodeFSP.writeFile(NodePath.join(workspace, ".env.local"), "SECRET=agent\n", {
    mode: 0o600,
  });
  await NodeFSP.writeFile(NodePath.join(workspace, "huge.bin"), Buffer.alloc(11 * 1024 * 1024, 7));
  await NodeFSP.writeFile(NodePath.join(workspace, "node_modules", "chat-only.txt"), "derived\n");

  const thread = NodePath.join(home, ".t3", "worktrees", "repo", "thread-1");
  git(workspace, "worktree", "add", "-q", "-b", "t3/thread-1", thread);
  await NodeFSP.writeFile(NodePath.join(thread, "thread.txt"), "thread work\n");
  git(thread, "add", "thread.txt");
  await NodeFSP.appendFile(NodePath.join(thread, "README.md"), "thread unstaged\n");
  await NodeFSP.writeFile(NodePath.join(thread, "thread-untracked.txt"), "thread untracked\n");

  const transcripts = NodePath.join(home, ".claude", "projects", "-root-workspace");
  await NodeFSP.mkdir(transcripts, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(transcripts, "session.jsonl"), '{"turn":1}\n{"turn":2}\n');
  await NodeFSP.mkdir(NodePath.join(home, ".codex", "sessions"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(home, ".codex", "sessions", "rollout.jsonl"),
    '{"codex":1}\n',
  );
  await NodeFSP.writeFile(NodePath.join(home, ".npm", "chat-cache"), "derived\n");
  const stopWriter = await openDatabaseWriter(
    NodePath.join(home, ".t3", "userdata", "state.sqlite"),
    25,
  );
  // An uncheckpointed WAL left by a writer that died without closing, as a killed server leaves it.
  stopWriter();
}

const DURABLE_SKIP = [...DERIVED_HOME_PATHS, ".t3/worktrees"];

/**
 * Git records a working-tree file's executable bit and nothing else of its
 * mode, so tree files compare on that bit; home files keep their full mode.
 */
async function hashTree(base: string, entries: ReadonlyArray<string>, modeMask: number) {
  const result: Record<string, string> = {};
  for (const rel of entries) {
    const path = NodePath.join(base, rel);
    const stat = await NodeFSP.lstat(path);
    if (stat.isSymbolicLink()) result[rel] = `link:${await NodeFSP.readlink(path)}`;
    else if (stat.isFile())
      result[rel] = `${(stat.mode & modeMask).toString(8)}:${sha256(await NodeFSP.readFile(path))}`;
  }
  return result;
}

async function walkFiles(base: string, skip: ReadonlyArray<string>, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(base, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (skip.some((path) => child === path || child.startsWith(`${path}/`))) continue;
    if (entry.isDirectory()) found.push(...(await walkFiles(base, skip, child)));
    else found.push(child);
  }
  return found;
}

/** Every piece of chat state a resume must reproduce, as content hashes and git's own views. */
async function chatState(root: string) {
  const workspace = NodePath.join(root, "workspace");
  const trees = git(workspace, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const perTree: Record<string, unknown> = {};
  for (const tree of trees) {
    const listed = git(tree, "ls-files", "-co", "--exclude-standard", "-z").split("\0");
    const ignored = git(tree, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z")
      .split("\0")
      .filter((rel) => rel && !rel.endsWith("/"));
    const present: string[] = [];
    for (const rel of [...listed, ...ignored].filter(Boolean))
      if ((await NodeFSP.lstat(NodePath.join(tree, rel)).catch(() => null)) !== null) {
        const size = (await NodeFSP.lstat(NodePath.join(tree, rel))).size;
        if (size <= 10 * 1024 * 1024) present.push(rel);
      }
    perTree[NodePath.relative(root, tree)] = {
      head:
        git(tree, "rev-parse", "--symbolic-full-name", "HEAD") || git(tree, "rev-parse", "HEAD"),
      status: statusLines(tree),
      index: git(tree, "ls-files", "-s"),
      files: await hashTree(tree, [...new Set(present)].sort(), 0o100),
    };
  }
  const home = NodePath.join(root, "home");
  const journal = JSON.parse(
    await NodeFSP.readFile(NodePath.join(root, "preparation.json"), "utf8"),
  );
  return {
    refs: git(workspace, "for-each-ref", "--format=%(refname) %(objectname)"),
    stash: git(workspace, "stash", "list", "--format=%H %gs"),
    trees: perTree,
    home: await hashTree(home, (await walkFiles(home, DURABLE_SKIP)).sort(), 0o777),
    brokerToken: sha256(await NodeFSP.readFile(NodePath.join(root, "broker-token"))),
    journal: {
      intent: journal.intent,
      environmentId: journal.environmentId,
      installed: journal.installedFiles,
    },
  };
}

/**
 * A filler seals the volume's template at c1 and commits it; a new chat then
 * starts on that template at c2, does a turn's work, and saves.
 */
async function savedChat(w: World, store: Awaited<ReturnType<typeof artifactStore>>) {
  const c1 = w.head();
  await w.newMac("empty");
  expect(await adoptChatTemplate(localPort, templateIdentity(w))).toBe("miss");
  const filler = await w.prepareInput("filler-chat", c1);
  await prepareRemoteHost(localPort, filler);
  await sealChatTemplate(localPort, { ...templateIdentity(w), files: filler.files });
  await saveChat(localPort, {
    root: w.root,
    mode: "final",
    uploadUrl: store.url("filler"),
    maxBytes: 64 * 1024 * 1024,
    previousFingerprint: null,
  });
  await scrubChatRoot(localPort, { mount: w.mount, root: w.root });
  await w.depart("commit");

  const c2 = await w.advance("c2");
  await w.newMac();
  expect(await adoptChatTemplate(localPort, templateIdentity(w))).toBe("hit");
  const chat = await w.prepareInput("chat-1", c2);
  const ready = await prepareRemoteHost(localPort, chat);
  await doChatWork(w);
  const expected = await chatState(w.root);
  const saved = await saveChat(localPort, {
    root: w.root,
    mode: "final",
    uploadUrl: store.url("chat-1/1"),
    maxBytes: 64 * 1024 * 1024,
    previousFingerprint: null,
  });
  if (saved.kind !== "saved") throw new Error("expected a saved snapshot");
  await w.depart("abandon");
  return { c1, c2, chat, environmentId: ready.environmentId, expected, saved };
}

const workspaceStatus = [
  " D remove-me.txt",
  " M README.md",
  "?? notes/readme-link",
  "?? untracked.txt",
  "M  staged.txt",
];

describe("guest chat state", () => {
  it("restores a released chat byte for byte onto a template at another revision, then prepares it in place", async () => {
    const w = await world();
    const store = await artifactStore();
    const { c1, chat, environmentId, expected, saved } = await savedChat(w, store);

    await w.newMac();
    expect(await adoptChatTemplate(localPort, templateIdentity(w))).toBe("hit");
    expect(
      (
        await NodeFSP.readFile(
          NodePath.join(w.root, "workspace.partial", "node_modules", ".installed-at"),
          "utf8",
        )
      ).trim(),
      "the adopted template is a checkout of the earlier revision",
    ).toBe(c1);
    await restoreChat(localPort, {
      root: w.root,
      snapshot: { url: store.url("chat-1/1"), sha256: saved.sha256 },
    });

    expect(await chatState(w.root)).toEqual(expected);
    const workspace = NodePath.join(w.root, "workspace");
    expect(statusLines(workspace)).toEqual(workspaceStatus);
    expect(git(workspace, "stash", "list", "--format=%gs")).toBe(
      "On main: second stash\nOn main: first stash",
    );
    expect(git(workspace, "stash", "show", "--name-only", "stash@{1}")).toBe("stashed-first.txt");
    expect(git(workspace, "for-each-ref", "--format=%(refname)", "refs/t3")).toBe(
      "refs/t3/checkpoints/thread-1/turn/1",
    );
    expect(await NodeFSP.readFile(NodePath.join(workspace, ".env.local"), "utf8")).toBe(
      "SECRET=agent\n",
    );
    expect(
      sqlite(
        NodePath.join(w.root, "home/.t3/userdata/state.sqlite"),
        "select count(*) from events",
      ),
    ).toBe("[(25,)]");
    expect(
      await NodeFSP.readFile(NodePath.join(w.root, "home/.t3/userdata/environment-id"), "utf8"),
    ).toBe(`${environmentId}\n`);

    expect(
      await exists(NodePath.join(workspace, "huge.bin")),
      "ignored files over 10 MiB are derived",
    ).toBe(false);
    expect(
      await exists(NodePath.join(workspace, "node_modules", "chat-only.txt")),
      "node_modules is derived",
    ).toBe(false);
    expect(
      (
        await NodeFSP.readFile(NodePath.join(workspace, "node_modules", ".installed-at"), "utf8")
      ).trim(),
      "dependencies are the template's until preparation updates them",
    ).toBe(c1);
    expect(
      await exists(NodePath.join(w.root, "home/.npm/chat-cache")),
      "home caches are derived",
    ).toBe(false);
    expect(await NodeFSP.readFile(NodePath.join(w.root, "home/.npm/prepared"), "utf8")).toBe(
      "cache\n",
    );

    const reopened = await prepareRemoteHost(localPort, chat);
    expect(reopened.environmentId).toBe(environmentId);
    expect(statusLines(workspace)).toEqual(workspaceStatus);
  });

  it("restores a released chat onto an empty volume after a cache miss", async () => {
    const w = await world();
    const store = await artifactStore();
    const { chat, environmentId, expected, saved } = await savedChat(w, store);

    await w.newMac("empty");
    expect(await adoptChatTemplate(localPort, templateIdentity(w))).toBe("miss");
    await restoreChat(localPort, {
      root: w.root,
      snapshot: { url: store.url("chat-1/1"), sha256: saved.sha256 },
    });

    expect(await chatState(w.root)).toEqual(expected);
    expect(await exists(NodePath.join(w.root, "workspace", "node_modules"))).toBe(false);
    expect(await exists(NodePath.join(w.root, "home/.npm"))).toBe(false);
    expect(await exists(NodePath.join(w.root, "runtime"))).toBe(false);

    const reopened = await prepareRemoteHost(localPort, chat);
    expect(reopened.environmentId).toBe(environmentId);
    expect(statusLines(NodePath.join(w.root, "workspace"))).toEqual(workspaceStatus);
  });

  it("converges when a restore is rerun after stopping at any point", async () => {
    const w = await world();
    const store = await artifactStore();
    const { expected, saved } = await savedChat(w, store);
    const snapshot = { url: store.url("chat-1/1"), sha256: saved.sha256 };

    await w.newMac();
    await adoptChatTemplate(localPort, templateIdentity(w));
    await expect(
      restoreChat(localPort, { root: w.root, snapshot: { ...snapshot, url: store.url("filler") } }),
    ).rejects.toThrow("Snapshot digest mismatch");
    await restoreChat(localPort, { root: w.root, snapshot });
    expect(await chatState(w.root)).toEqual(expected);

    await restoreChat(localPort, { root: w.root, snapshot });
    expect(await chatState(w.root), "a finished restore is not redone").toEqual(expected);

    const receipt = NodePath.join(w.root, "restore.json");
    await NodeFSP.writeFile(receipt, JSON.stringify({ sha256: saved.sha256, done: false }));
    await restoreChat(localPort, { root: w.root, snapshot });
    expect(await chatState(w.root), "stopped after writing the journal").toEqual(expected);

    await NodeFSP.writeFile(receipt, JSON.stringify({ sha256: saved.sha256, done: false }));
    await NodeFSP.rm(NodePath.join(w.root, "preparation.json"));
    await restoreChat(localPort, { root: w.root, snapshot });
    expect(await chatState(w.root), "stopped after laying down the workspace and home").toEqual(
      expected,
    );

    await expect(
      restoreChat(localPort, { root: w.root, snapshot: { ...snapshot, sha256: "0".repeat(64) } }),
    ).rejects.toThrow("This root holds a different restore");
  });

  it("saves a consistent database under a live writer, and skips a root that has not changed", async () => {
    const w = await world();
    const store = await artifactStore();
    await w.newMac("empty");
    await adoptChatTemplate(localPort, templateIdentity(w));
    const chat = await w.prepareInput("chat-live", w.head());
    await prepareRemoteHost(localPort, chat);
    await openDatabaseWriter(NodePath.join(w.root, "home/.t3/userdata/state.sqlite"), 40);
    const save = (key: string, previousFingerprint: string | null) =>
      saveChat(localPort, {
        root: w.root,
        mode: "live",
        uploadUrl: store.url(key),
        maxBytes: 64 * 1024 * 1024,
        previousFingerprint,
      });

    const first = await save("live/1", null);
    if (first.kind !== "saved") throw new Error("expected a saved snapshot");
    expect(await save("live/2", first.fingerprint)).toEqual({
      kind: "unchanged",
      fingerprint: first.fingerprint,
    });
    expect(store.object("live/2"), "an unchanged root uploads nothing").toBeUndefined();
    await NodeFSP.writeFile(NodePath.join(w.root, "workspace", "later.txt"), "later\n");
    const second = await save("live/3", first.fingerprint);
    expect(second.kind).toBe("saved");
    if (second.kind !== "saved") throw new Error("expected a saved snapshot");

    await w.depart("abandon");
    await w.newMac("empty");
    await adoptChatTemplate(localPort, templateIdentity(w));
    await restoreChat(localPort, {
      root: w.root,
      snapshot: { url: store.url("live/3"), sha256: second.sha256 },
    });
    const database = NodePath.join(w.root, "home/.t3/userdata/state.sqlite");
    expect(await exists(`${database}-wal`), "a live save copies the database, not its WAL").toBe(
      false,
    );
    expect(sqlite(database, "pragma integrity_check")).toBe("[('ok',)]");
    expect(sqlite(database, "select count(*) from events")).toBe("[(40,)]");
    expect(await NodeFSP.readFile(NodePath.join(w.root, "workspace", "later.txt"), "utf8")).toBe(
      "later\n",
    );
    expect(
      git(NodePath.join(w.root, "workspace"), "rev-parse", "--abbrev-ref", "HEAD"),
      "a branch with no commits of its own still comes back",
    ).toBe("main");
  });

  it("keeps every chat's state out of the shared template and never adopts an unsealed volume", async () => {
    const w = await world();
    const store = await artifactStore();
    await w.newMac("empty");
    await adoptChatTemplate(localPort, templateIdentity(w));
    const filler = await w.prepareInput("filler-chat", w.head());
    await prepareRemoteHost(localPort, filler);
    await sealChatTemplate(localPort, { ...templateIdentity(w), files: filler.files });
    const marker = await NodeFSP.readFile(NodePath.join(w.mount, "template.json"), "utf8");
    await sealChatTemplate(localPort, { ...templateIdentity(w), files: filler.files });
    expect(
      await NodeFSP.readFile(NodePath.join(w.mount, "template.json"), "utf8"),
      "a second seal is a no-op",
    ).toBe(marker);

    const template = NodePath.join(w.mount, "template");
    expect((await NodeFSP.readdir(template)).sort()).toEqual([
      "artifact",
      "home",
      "warm.json",
      "workspace.partial",
    ]);
    expect((await walkFiles(NodePath.join(template, "home"), [])).sort()).toEqual([
      ".local/bin/tool",
      ".npm/prepared",
    ]);
    const partial = NodePath.join(template, "workspace.partial");
    expect(git(partial, "for-each-ref", "--format=%(refname)")).toBe("refs/remotes/origin/main");
    expect(git(partial, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD is detached").toBe("HEAD");

    await saveChat(localPort, {
      root: w.root,
      mode: "final",
      uploadUrl: store.url("filler"),
      maxBytes: 64 * 1024 * 1024,
      previousFingerprint: null,
    });
    await scrubChatRoot(localPort, { mount: w.mount, root: w.root });
    await scrubChatRoot(localPort, { mount: w.mount, root: w.root });
    expect((await NodeFSP.readdir(w.mount)).sort()).toEqual([
      "cache.lock",
      "template",
      "template.json",
    ]);
    await expect(
      saveChat(localPort, {
        root: w.root,
        mode: "final",
        uploadUrl: store.url("never"),
        maxBytes: 64 * 1024 * 1024,
        previousFingerprint: null,
      }),
    ).rejects.toThrow("No prepared chat lives at this root");
    await w.depart("commit");

    await w.newMac();
    expect(await adoptChatTemplate(localPort, templateIdentity(w))).toBe("hit");
    expect(
      await adoptChatTemplate(localPort, templateIdentity(w)),
      "a rerun returns its receipt",
    ).toBe("hit");
    expect(
      await exists(NodePath.join(w.mount, "template.json")),
      "adoption removes the marker first",
    ).toBe(false);
    const reader = await w.prepareInput("reader-chat", w.head());
    await prepareRemoteHost(localPort, reader);
    // A reader whose halt was skipped: its volume, chat root and all, becomes the next parent.
    await w.depart("commit");

    await w.newMac();
    expect(await adoptChatTemplate(localPort, templateIdentity(w))).toBe("miss");
    expect(await NodeFSP.readdir(w.root), "the poisoned chat root is never handed out").toEqual([
      "adopt.json",
    ]);
  });

  it("adopts a stale template but drops a runtime the new chat does not run", async () => {
    const w = await world();
    await w.newMac("empty");
    await adoptChatTemplate(localPort, templateIdentity(w));
    const filler = await w.prepareInput("filler-chat", w.head());
    await prepareRemoteHost(localPort, filler);
    await sealChatTemplate(localPort, { ...templateIdentity(w), files: filler.files });
    await w.depart("commit");

    await w.newMac();
    expect(await adoptChatTemplate(localPort, templateIdentity(w, "prepare-v2"))).toBe("stale");
    expect(
      await exists(NodePath.join(w.root, "warm.json")),
      "same runtime: its record is kept",
    ).toBe(true);

    await w.newMac();
    expect(
      await adoptChatTemplate(localPort, { ...templateIdentity(w), runtimeSha256: "d".repeat(64) }),
    ).toBe("stale");
    expect(await exists(NodePath.join(w.root, "warm.json"))).toBe(false);
    expect(await exists(NodePath.join(w.root, "artifact"))).toBe(false);
    expect(await exists(NodePath.join(w.root, "workspace.partial", ".git"))).toBe(true);
  });
});
