// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off globalDate:off globalDateInEffect:off globalErrorInEffectFailure:off globalTimers:off - an operator CLI that drives git, tar and the local filesystem directly and reports to the terminal.
/**
 * Moves a chat between this Mac and a cloud box with its agent's memory: the checkout exactly as
 * it is on disk, and the agent's native Claude session, so the agent continues the same
 * conversation instead of reading a summary of it.
 *
 *   node scripts/cloud/move-chat.ts to-cloud --thread <local thread id> --message-file first.md \
 *     [--include .env --include-cap-mb 50]
 *   node scripts/cloud/move-chat.ts to-local --sandbox <e2b sandbox id> --worktree <dir> \
 *     --claude-config-dir ~/.claude
 *   node scripts/cloud/move-chat.ts carry --sandbox <e2b sandbox id> --thread <local thread id> \
 *     [--dry-run]
 *
 * to-cloud reads the local desktop app's database read-only, pushes the snapshot to
 * `handoff/move-*`, provisions an E2B box on the manager for it, imports the session there with
 * the box's own agent session importer, and sends the first message. Re-running it with the same
 * thread picks up where an interrupted run stopped.
 *
 * Both to-cloud (unless --no-carry) and carry also copy what the agent used outside its checkout,
 * found in its session record, to the same absolute paths on the box, plus the repo's Claude memory.
 *
 *   node scripts/cloud/move-chat.ts restore --environment <environment id> [--uri s3://bucket/prefix] \
 *     [--account <host account>] [--message <extra text>] [--dry-run]
 *
 * restore brings back a cloud chat whose box is lost or will not resume, from the backup the host
 * took before the box slept: it reads `<uri>/<environment>/backups/latest/` with this Mac's AWS
 * credentials, provisions a fresh box on the backup branch (or the chat's branch when nothing was
 * unsaved), imports the chat's Claude session there as to-cloud does, and tells the agent what came
 * back. `--uri` defaults to the host config's workerForks.outputsUri.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeStream from "node:stream";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";
import {
  CommandId,
  defaultInstanceIdForDriver,
  MessageId,
  ModelSelection,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProvisionRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { Sandbox } from "e2b";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import {
  type CarryPlan,
  type CarryProbe,
  claudeProjectDirName,
  claudeSessionPath,
  formatBytes,
  githubRepository,
  planCarry,
  planRestore,
  referencedPaths,
  rewriteSessionCwd,
  SNAPSHOT_SCRIPT,
  snapshotCheckout,
} from "./moveChat.ts";
import { BackupManifest, backupUri } from "../../apps/server/src/environmentControl/boxBackup.ts";
import { childPairingUrl, exchangePairingToken, type T3Client, withRpc } from "./t3Rpc.ts";
import { advanceTurn, initialProgress, type TurnProgress } from "./turnProgress.ts";

const BOX_HOME = "/home/user";
const BOX_WORKSPACE = `${BOX_HOME}/.t3-provision/workspace`;
const BOX_CARRY_TAR = "/tmp/move-chat-carry.tgz";
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const BOX_INSTANCE = defaultInstanceIdForDriver(CLAUDE);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
const decodeBackupManifest = Schema.decodeUnknownSync(Schema.fromJsonString(BackupManifest));
const STATE_DIR = NodePath.join(NodeOS.homedir(), ".t3", "move-chat");

const sh = (cwd: string, command: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
const log = (line: string) => console.log(`[move-chat] ${line}`);

/** The chat as the local desktop app (V1) stores it, read without ever opening it for writing. */
function readLocalChat(threadId: string, t3Home: string) {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(t3Home, "userdata", "state.sqlite"), {
    readOnly: true,
  });
  try {
    const thread = db
      .prepare(
        `select t.title, t.worktree_path as worktreePath, p.workspace_root as workspaceRoot
         from projection_threads t join projection_projects p on p.project_id = t.project_id
         where t.thread_id = ?`,
      )
      .get(threadId) as
      | { title: string; worktreePath: string | null; workspaceRoot: string }
      | undefined;
    const runtime = db
      .prepare(
        `select r.provider_name as driver, r.provider_instance_id as instanceId,
                r.resume_cursor_json as cursor, r.runtime_payload_json as payload,
                s.status as sessionStatus, s.active_turn_id as activeTurnId
         from provider_session_runtime r
         left join projection_thread_sessions s on s.thread_id = r.thread_id
         where r.thread_id = ?`,
      )
      .get(threadId) as
      | {
          driver: string;
          instanceId: string;
          cursor: string;
          payload: string;
          sessionStatus: string | null;
          activeTurnId: string | null;
        }
      | undefined;
    if (!thread || !runtime) throw new Error(`no local thread ${threadId} with an agent session`);
    if (runtime.driver !== CLAUDE)
      throw new Error(`thread ${threadId} runs on ${runtime.driver}; only Claude sessions move`);
    const cursor = JSON.parse(runtime.cursor) as { resume?: string };
    const payload = JSON.parse(runtime.payload) as { cwd?: string; modelSelection?: unknown };
    if (!cursor.resume) throw new Error(`thread ${threadId} has no Claude session to resume`);
    const settings = JSON.parse(
      NodeFS.readFileSync(NodePath.join(t3Home, "userdata", "settings.json"), "utf8"),
    );
    const instance = settings.providerInstances?.[runtime.instanceId];
    const configDir: string =
      instance?.config?.homePath ||
      instance?.environment?.findLast((v: { name: string }) => v.name === "CLAUDE_CONFIG_DIR")
        ?.value ||
      process.env.CLAUDE_CONFIG_DIR ||
      NodePath.join(NodeOS.homedir(), ".claude");
    return {
      threadId,
      title: thread.title,
      cwd: payload.cwd ?? thread.worktreePath ?? thread.workspaceRoot,
      sessionId: cursor.resume,
      instanceId: runtime.instanceId,
      modelSelection: decodeModelSelection(payload.modelSelection),
      configDir,
      running: runtime.sessionStatus === "running" || runtime.activeTurnId !== null,
    };
  } finally {
    db.close();
  }
}

function e2bApiKey(): string {
  if (process.env.E2B_API_KEY) return process.env.E2B_API_KEY;
  const found: Array<string> = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string" && value.startsWith("e2b_")) found.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(
    JSON.parse(
      NodeFS.readFileSync(
        NodePath.join(NodeOS.homedir(), ".t3", "environment-control.json"),
        "utf8",
      ),
    ),
  );
  if (!found[0]) throw new Error("set E2B_API_KEY or add an e2b_ key to environment-control.json");
  return found[0];
}

/**
 * What a box's T3 server runs with: its environment, which git on the box needs to push, and
 * the Claude config directory its agent reads sessions from.
 */
async function boxRuntime(sandbox: Sandbox) {
  const processes = await sandbox.commands.run("ps -eo pid=,args=");
  const server = processes.stdout
    .split("\n")
    .map((line) => /^\s*(\d+) .*\/dist\/bin\.mjs start .*--base-dir (\S+)/.exec(line))
    .find((match) => match !== null);
  if (!server) throw new Error("no T3 server process on the box");
  const [, pid, baseDir] = server;
  const environ = await sandbox.commands.run(`tr '\\0' '\\n' < /proc/${pid}/environ`);
  const env: Record<string, string> = Object.fromEntries(
    environ.stdout
      .split("\n")
      .filter((entry) => entry.includes("="))
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
  );
  const settings = await sandbox.files
    .read(`${baseDir}/userdata/settings.json`)
    .then((text) => JSON.parse(text))
    .catch(() => ({}));
  const instance = settings.providerInstances?.[BOX_INSTANCE];
  const claudeDir: string =
    instance?.config?.homePath ||
    instance?.environment?.findLast((v: { name: string }) => v.name === "CLAUDE_CONFIG_DIR")
      ?.value ||
    env.CLAUDE_CONFIG_DIR ||
    `${env.HOME}/.claude`;
  return { env, claudeDir };
}

/** The main transcript of a Claude session, its subagents' transcripts and its saved tool outputs. */
function sessionRecord(sessionFile: string) {
  const dir = sessionFile.replace(/\.jsonl$/, "");
  const files = (sub: string) =>
    NodeFS.existsSync(`${dir}/${sub}`)
      ? NodeFS.readdirSync(`${dir}/${sub}`).map((name) => `${dir}/${sub}/${name}`)
      : [];
  const read = (file: string) => NodeFS.readFileSync(file, "utf8");
  return {
    transcripts: [sessionFile, ...files("subagents").filter((f) => f.endsWith(".jsonl"))].map(read),
    outputs: files("tool-results").map(read),
  };
}

function probeCarry(path: string, capBytes: number): CarryProbe {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.lstatSync(path);
  } catch {
    return { kind: "missing" };
  }
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.spawnSync(
      "git",
      ["-C", stat.isDirectory() ? path : NodePath.dirname(path), ...args],
      { encoding: "utf8" },
    );
  const root = git("rev-parse", "--show-toplevel");
  if (root.status === 0) {
    const remote = git("remote", "get-url", "origin");
    return {
      kind: "repo",
      root: root.stdout.trim().replace(/^\/private\/tmp\//, "/tmp/"),
      remote: remote.status === 0 ? remote.stdout.trim() : null,
    };
  }
  let bytes = 0;
  let holdsRepo = false;
  // Stops once the answer is known, so a huge directory costs no more than the cap to measure.
  const walk = (entry: string, entryStat: NodeFS.Stats) => {
    if (bytes > capBytes || holdsRepo) return;
    if (!entryStat.isDirectory()) {
      bytes += entryStat.size;
      return;
    }
    const names = NodeFS.readdirSync(entry);
    if (names.includes(".git")) holdsRepo = true;
    for (const name of names) {
      // A live /tmp tree can lose a file between listing and reading it.
      const child = NodeFS.lstatSync(`${entry}/${name}`, { throwIfNoEntry: false });
      if (child) walk(`${entry}/${name}`, child);
    }
  };
  walk(path, stat);
  return { kind: "tree", bytes, holdsRepo };
}

interface Carry {
  readonly plan: CarryPlan;
  readonly skipped: CarryPlan["skipped"];
  /** The repo's Claude auto-memory, which Claude keys by the main checkout, not the worktree. */
  readonly memory: string | null;
}

function planLocalCarry(
  local: { cwd: string; configDir: string },
  sessionFile: string,
  caps: { itemBytes: number; totalBytes: number },
): Carry {
  const found = referencedPaths(sessionRecord(sessionFile), {
    home: NodeOS.homedir(),
    cwd: local.cwd,
  });
  const plan = planCarry(found.paths, (path) => probeCarry(path, caps.itemBytes), caps);
  const mainRoot = NodePath.dirname(
    sh(local.cwd, "git", "rev-parse", "--path-format=absolute", "--git-common-dir"),
  );
  const memory = `${local.configDir}/projects/${claudeProjectDirName(mainRoot)}/memory`;
  const carry = {
    plan,
    skipped: [
      ...plan.skipped,
      ...found.toolConfig
        .filter((path) => NodeFS.existsSync(path))
        .map((path) => ({ path, reason: "tool config" })),
    ],
    memory: NodeFS.existsSync(memory) ? memory : null,
  };
  const total = plan.carry.reduce((sum, item) => sum + item.bytes, 0);
  log(`carry ${plan.carry.length} path(s), ${formatBytes(total)}`);
  for (const item of plan.carry) console.log(`  carried  ${item.path}  ${formatBytes(item.bytes)}`);
  if (carry.memory) console.log(`  carried  ${carry.memory}  Claude memory, merged`);
  for (const item of carry.skipped) console.log(`  skipped  ${item.path}  ${item.reason}`);
  return carry;
}

function carryNote(carry: Carry): string {
  const toolConfig = carry.skipped.filter((item) => item.reason === "tool config");
  return [
    "Files you used outside the checkout were copied to the same absolute paths on this box:",
    ...carry.plan.carry.map((item) => `- ${item.path}`),
    ...(carry.memory ? ["Your Claude memory for this repo was merged in."] : []),
    "Not copied:",
    ...carry.skipped
      .filter((item) => item.reason !== "tool config")
      .map((item) => `- ${item.path} (${item.reason})`),
    `- tool config, which this box has its own of: ${toolConfig.map((item) => item.path).join(", ")}`,
  ].join("\n");
}

/**
 * Streams the carried paths to the box in one tar, renamed so home paths land under the box home
 * (which the local home also links to) and the memory lands in the box's Claude project. Files the
 * box already has at the same age or newer are kept, so reruns converge.
 */
async function uploadCarry(sandbox: Sandbox, claudeDir: string, carry: Carry) {
  const home = NodeOS.homedir();
  const tmp = NodeFS.realpathSync("/tmp");
  const boxMemory = `${claudeDir}/projects/${claudeProjectDirName(BOX_WORKSPACE)}/memory`;
  const members = [
    ...carry.plan.carry.map(({ path }) => (path.startsWith("/tmp/") ? tmp + path.slice(4) : path)),
    ...(carry.memory ? [carry.memory] : []),
  ].map((path) => path.slice(1));
  if (members.length === 0) return;
  // bsdtar uses the first rename that matches, so the memory rename goes before the home one.
  const renames = [
    ...(carry.memory ? [`,^${carry.memory.slice(1)},${boxMemory.slice(1)},`] : []),
    `,^${tmp.slice(1)}/,tmp/,`,
    `,^${home.slice(1)}/,${BOX_HOME.slice(1)}/,`,
  ];
  // Files only: GNU tar's --keep-newer-files fails on directory entries that already exist.
  const find = NodeChildProcess.spawn("find", [...members, "!", "-type", "d"], {
    cwd: "/",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const tar = NodeChildProcess.spawn(
    "tar",
    [
      "-cf",
      "-",
      "-n",
      "-T",
      "-",
      "--no-mac-metadata",
      "--no-xattrs",
      ...renames.flatMap((r) => ["-s", r]),
      "-C",
      "/",
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: [find.stdout, "pipe", "inherit"] },
  );
  const exited = Promise.all(
    [find, tar].map((child) => new Promise<number | null>((done) => child.on("exit", done))),
  );
  // Compressed here: bsdtar pads its own gzip output, which GNU tar on the box rejects.
  await sandbox.files.write(
    BOX_CARRY_TAR,
    NodeStream.Readable.toWeb(tar.stdout.pipe(NodeZlib.createGzip())) as ReadableStream,
  );
  if ((await exited).some((code) => code !== 0))
    throw new Error("find or tar could not pack the carried paths");
  await sandbox.commands.run(
    [
      `{ [ -e ${home} ] || { sudo mkdir -p ${NodePath.dirname(home)} && sudo ln -s ${BOX_HOME} ${home}; }; }`,
      `tar -xzf ${BOX_CARRY_TAR} --keep-newer-files --warning=no-ignore-newer -C /`,
      `rm -f ${BOX_CARRY_TAR}`,
    ].join(" && "),
    { timeoutMs: 0 },
  );
  log(`carried ${members.length} path(s) to the box`);
}

interface MoveState {
  readonly requestId: string;
  readonly bootstrapCommandId: string;
  readonly bootstrapMessageId: string;
  readonly detachCommandId: string;
  readonly commandId: string;
  readonly messageId: string;
  sandboxId?: string;
  /** Set once the box's session file holds the moved history; never written again after. */
  swapped?: boolean;
}

function loadState(threadId: string): MoveState {
  const file = NodePath.join(STATE_DIR, `${threadId}.json`);
  if (NodeFS.existsSync(file)) return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  return {
    requestId: NodeCrypto.randomUUID(),
    bootstrapCommandId: NodeCrypto.randomUUID(),
    bootstrapMessageId: NodeCrypto.randomUUID(),
    detachCommandId: NodeCrypto.randomUUID(),
    commandId: NodeCrypto.randomUUID(),
    messageId: NodeCrypto.randomUUID(),
  };
}

/**
 * Sets a finished or dead move's state aside, so moving the same chat again starts a new move
 * instead of replaying this one's request and message ids.
 */
function retireState(threadId: string, state: MoveState, outcome: "done" | "failed") {
  const file = NodePath.join(STATE_DIR, `${threadId}.json`);
  if (NodeFS.existsSync(file))
    NodeFS.renameSync(
      file,
      NodePath.join(STATE_DIR, `${threadId}.${state.requestId}.${outcome}.json`),
    );
}

function saveState(threadId: string, state: MoveState) {
  NodeFS.mkdirSync(STATE_DIR, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(STATE_DIR, `${threadId}.json`),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** Follows a turn on the box until its run settles or `minutes` pass, whichever is first. */
const watchTurn = (client: T3Client, threadId: ThreadId, messageId: string, minutes: number) =>
  Effect.gen(function* () {
    let progress: TurnProgress = initialProgress;
    yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.runForEachWhile((item) =>
        Effect.sync(() => {
          progress = advanceTurn(progress, item, messageId, Date.now());
          return progress.completedAt === null;
        }),
      ),
      Effect.timeoutOption(`${minutes} minutes`),
    );
    return progress;
  });

const projectionOf = (client: T3Client, threadId: ThreadId) =>
  client["orchestration.subscribeThread"]({ threadId }).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.runHead,
    Effect.map(
      Option.flatMap((item) =>
        item.kind === "snapshot" ? Option.some(item.projection) : Option.none(),
      ),
    ),
    Effect.timeoutOption("1 minute"),
    Effect.map((found) => (Option.isSome(found) ? Option.getOrNull(found.value) : null)),
    // A thread the box has never had answers with an error rather than an empty snapshot.
    Effect.orElseSucceed(() => null),
  );

async function toCloud(flags: {
  thread: string;
  text: string;
  t3Home: string;
  origin: string;
  bearer: string;
  include: ReadonlyArray<string>;
  includeCapBytes: number;
  watchMinutes: number;
  dryRun: boolean;
  carryCaps: { itemBytes: number; totalBytes: number } | null;
}) {
  const local = readLocalChat(flags.thread, flags.t3Home);
  if (local.running)
    throw new Error(`"${local.title}" is running locally; stop it before moving it`);
  const sessionFile = claudeSessionPath(local);
  if (!NodeFS.existsSync(sessionFile)) throw new Error(`no Claude session at ${sessionFile}`);
  const repository = githubRepository(sh(local.cwd, "git", "remote", "get-url", "origin"));
  if (!repository) throw new Error(`${local.cwd} has no GitHub origin`);
  const carry = flags.carryCaps ? planLocalCarry(local, sessionFile, flags.carryCaps) : null;

  const commit = snapshotCheckout(local.cwd, `move-chat: snapshot of "${local.title}"`);
  const branch = `handoff/move-${local.threadId.slice(0, 8)}-${commit.slice(0, 8)}`;
  if (flags.dryRun) {
    const { modelSelection, ...chat } = local;
    console.log(
      JSON.stringify({ ...chat, modelSelection, sessionFile, repository, commit, branch }, null, 2),
    );
    return;
  }
  sh(local.cwd, "git", "push", "--quiet", "origin", `${commit}:refs/heads/${branch}`);
  log(`checkout ${local.cwd} at ${commit} pushed to ${repository}@${branch}`);

  const extras =
    flags.include.length === 0
      ? null
      : NodeChildProcess.execFileSync("tar", ["-czf", "-", "--", ...flags.include], {
          cwd: local.cwd,
          maxBuffer: flags.includeCapBytes + 1,
        });
  if (extras && extras.byteLength > flags.includeCapBytes)
    throw new Error(`--include is ${extras.byteLength} bytes compressed, over the cap`);

  await continueOnBox({
    stateKey: local.threadId,
    account: local.instanceId,
    repository,
    branch,
    sessionId: local.sessionId,
    sessionText: rewriteSessionCwd(
      NodeFS.readFileSync(sessionFile, "utf8"),
      local.cwd,
      BOX_WORKSPACE,
    ),
    title: local.title,
    modelSelection: local.modelSelection,
    header: `Moved from the Mac: continues local thread "${local.title}" (${local.threadId}), Claude session ${local.sessionId}, checkout ${branch}. Reply with only: ok`,
    text: carry ? `${flags.text}\n\n${carryNote(carry)}` : flags.text,
    origin: flags.origin,
    bearer: flags.bearer,
    watchMinutes: flags.watchMinutes,
    prepare: async (sandbox, claudeDir) => {
      if (extras) {
        await sandbox.files.write("/tmp/move-chat-extras.tgz", new Blob([extras]));
        await sandbox.commands.run(`tar -xzf /tmp/move-chat-extras.tgz -C ${BOX_WORKSPACE}`);
        log(`copied ${flags.include.join(", ")} into the box workspace`);
      }
      if (carry) await uploadCarry(sandbox, claudeDir, carry);
    },
  });
}

interface BoxMove {
  /** Names the resumable state file, so a rerun picks up where an interrupted run stopped. */
  readonly stateKey: string;
  /** The host account the box runs the chat on. */
  readonly account: string;
  readonly repository: string;
  readonly branch: string;
  readonly sessionId: string;
  /** The Claude transcript, its cwd already the box's workspace. */
  readonly sessionText: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  /** The first turn, which opens the session on the box; it should ask for only "ok". */
  readonly header: string;
  readonly text: string;
  readonly origin: string;
  readonly bearer: string;
  readonly watchMinutes: number;
  /** Puts files on the box before the session is imported. */
  readonly prepare?: (sandbox: Sandbox, claudeDir: string) => Promise<void>;
}

/**
 * Provisions an E2B box on the manager for a checkout, imports a Claude session there with the
 * box's own agent session importer, and sends the chat's next message.
 */
async function continueOnBox(move: BoxMove) {
  const state = loadState(move.stateKey);
  saveState(move.stateKey, state);
  const boxThreadId = ThreadId.make(`import:${BOX_INSTANCE}:${move.sessionId}`);
  const selection = { ...move.modelSelection, instanceId: BOX_INSTANCE };
  const movedText = move.sessionText;
  const boxSession = (claudeDir: string) =>
    claudeSessionPath({ configDir: claudeDir, cwd: BOX_WORKSPACE, sessionId: move.sessionId });
  // The importer finds a session by the cwd inside it, from any project directory. Staging it
  // away from the workspace's own directory lets the first turn create a fresh session there.
  const stagedSession = (claudeDir: string) =>
    `${claudeDir}/projects/t3-move-chat-staging/${move.sessionId}.jsonl`;

  const program = Effect.gen(function* () {
    const box = yield* withRpc(move.origin, move.bearer, (manager) =>
      Effect.gen(function* () {
        const config = yield* manager["server.getConfig"]({});
        if (!config.providers.some((provider) => provider.instanceId === move.account))
          return yield* Effect.fail(new Error(`the manager has no account ${move.account}`));
        const ready = yield* manager["environmentControl.provision"]({
          requestId: ProvisionRequestId.make(state.requestId),
          provider: "e2b",
          agentDriver: CLAUDE,
          providerInstanceId: move.account,
          pinAccount: true,
          repository: move.repository,
          branch: move.branch,
          chat: { threadId: boxThreadId },
        }).pipe(
          Effect.tap((result) => Effect.sync(() => log(`provision: ${result.kind}`))),
          Effect.repeat({
            while: (result) => result.kind === "pending" || result.kind === "allocation_unknown",
            schedule: Schedule.spaced("10 seconds"),
          }),
        );
        if (ready.kind !== "ready") {
          retireState(move.stateKey, state, "failed");
          return yield* Effect.fail(new Error(`provision ${ready.kind}: ${ready.message}`));
        }
        const attached = yield* manager["environmentControl.attach"]({
          requestId: ProvisionRequestId.make(state.requestId),
        });
        if (attached.kind !== "attached")
          return yield* Effect.fail(new Error(`attach refused: ${attached.message}`));
        const { pairingUrl } = childPairingUrl({
          // URL.parse, unlike new URL, never puts the credential-bearing input in an error.
          attachedPairingUrl:
            URL.parse(attached.pairingUrl) ??
            (yield* Effect.fail(new Error("the host returned an unreadable pairing URL"))),
          origin: move.origin,
          leaseId: ready.environment.leaseId,
        });
        const target = resolveRemotePairingTarget({ pairingUrl });
        const token = yield* exchangePairingToken(
          target.httpBaseUrl,
          target.credential,
          "move-chat",
        );
        return {
          environment: ready.environment,
          httpBaseUrl: target.httpBaseUrl,
          bearer: token.access_token,
        };
      }),
    );
    state.sandboxId = box.environment.sandboxId;
    saveState(move.stateKey, state);
    log(`box ${box.environment.sandboxId} (environment ${box.environment.environmentId})`);

    const sandbox = yield* Effect.promise(() =>
      Sandbox.connect(box.environment.sandboxId, { apiKey: e2bApiKey() }),
    );
    const runtime = yield* Effect.promise(() => boxRuntime(sandbox));
    log(`box Claude config ${runtime.claudeDir}`);
    const { prepare } = move;
    if (prepare) yield* Effect.promise(() => prepare(sandbox, runtime.claudeDir));

    yield* withRpc(box.httpBaseUrl, box.bearer, (client) =>
      Effect.gen(function* () {
        const project = yield* client["orchestration.subscribeShell"]({}).pipe(
          Stream.flatMap((item) =>
            Stream.fromIterable(item.kind === "snapshot" ? item.snapshot.projects : []),
          ),
          Stream.filter((candidate) => candidate.workspaceRoot === BOX_WORKSPACE),
          Stream.runHead,
          Effect.timeoutOption("3 minutes"),
          Effect.map(Option.flatten),
        );
        if (Option.isNone(project))
          return yield* Effect.fail(new Error(`no project at ${BOX_WORKSPACE} on the box`));
        yield* client["server.getConfig"]({}).pipe(
          Effect.map((config) =>
            config.providers.some(
              (provider) => provider.instanceId === BOX_INSTANCE && provider.models.length > 0,
            ),
          ),
          Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("3 seconds") }),
          Effect.timeout("3 minutes"),
        );

        if ((yield* projectionOf(client, boxThreadId)) === null) {
          yield* Effect.promise(() =>
            sandbox.files.write(stagedSession(runtime.claudeDir), movedText),
          );
          yield* client["agentSessions.scan"]({});
          const imported = yield* client["agentSessions.import"]({
            projectId: project.value.id,
            expectedWorkspaceRoot: BOX_WORKSPACE,
          });
          log(`imported ${imported.importedCount} session(s), skipped ${imported.skippedCount}`);
          yield* Effect.promise(() => sandbox.files.remove(stagedSession(runtime.claudeDir)));
          if ((yield* projectionOf(client, boxThreadId)) === null)
            return yield* Effect.fail(
              new Error(`the box did not import session ${move.sessionId}`),
            );
          yield* client["orchestration.dispatchCommand"]({
            type: "thread.metadata.update",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: boxThreadId,
            title: move.title,
          });
          // The importer files history as settled; this chat is live.
          yield* client["orchestration.dispatchCommand"]({
            type: "thread.unsettle",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: boxThreadId,
            reason: "user",
          });
        }

        if (!state.swapped) {
          // An imported Claude thread's first turn opens a fresh native session under the moved
          // session's id; resuming needs a prior turn. This turn is that, and doubles as the
          // header that says where the chat came from.
          const bootstrap = yield* client["orchestration.dispatchCommand"]({
            type: "message.dispatch",
            commandId: CommandId.make(state.bootstrapCommandId),
            createdBy: "user",
            creationSource: "web",
            threadId: boxThreadId,
            messageId: MessageId.make(state.bootstrapMessageId),
            text: move.header,
            attachments: [],
            modelSelection: selection,
            deliveryIntent: "auto",
            dispatchMode: { type: "start_immediately" },
          }).pipe(Effect.andThen(watchTurn(client, boxThreadId, state.bootstrapMessageId, 15)));
          if (bootstrap.completedAt === null || bootstrap.error !== null)
            return yield* Effect.fail(new Error(`header turn did not finish: ${bootstrap.error}`));
          const sessions = (bootstrap.projection as OrchestrationV2ThreadProjection)
            .providerSessions;
          for (const session of sessions.filter((candidate) => candidate.status !== "stopped"))
            yield* client["orchestration.dispatchCommand"]({
              type: "provider-session.detach",
              commandId: CommandId.make(`${state.detachCommandId}:${session.id}`),
              threadId: boxThreadId,
              providerSessionId: session.id,
              reason: "move-chat: reopen the moved native session",
            });
          yield* Effect.promise(async () => {
            for (let attempt = 0; attempt < 60; attempt += 1) {
              const alive = await sandbox.commands.run(
                `ps -eo args= | grep -F -- '${move.sessionId}' | grep -vc grep || true`,
              );
              if (alive.stdout.trim() === "0") return;
              await new Promise((done) => setTimeout(done, 2000));
            }
            throw new Error("the header turn's Claude process did not exit");
          });
          yield* Effect.promise(() =>
            sandbox.files.write(boxSession(runtime.claudeDir), movedText),
          );
          state.swapped = true;
          saveState(move.stateKey, state);
          log(`box session ${boxSession(runtime.claudeDir)} now holds the moved history`);
        }

        yield* client["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(state.commandId),
          createdBy: "user",
          creationSource: "web",
          threadId: boxThreadId,
          messageId: MessageId.make(state.messageId),
          text: move.text,
          attachments: [],
          modelSelection: selection,
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        });
        const turn = yield* watchTurn(client, boxThreadId, state.messageId, move.watchMinutes);
        const run = turn.projection?.runs.findLast(
          (candidate) => candidate.userMessageId === state.messageId,
        );
        log(
          `cloud thread ${boxThreadId} run ${run?.status ?? "not started"}${turn.error ? `: ${turn.error}` : ""}`,
        );
        console.log([...turn.assistant.values()].join("\n\n"));
      }),
    );
  });
  await Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer)));
  retireState(move.stateKey, state, "done");
}

async function toLocal(flags: {
  sandbox: string;
  worktree: string;
  claudeConfigDir: string;
  session: string | undefined;
}) {
  const sandbox = await Sandbox.connect(flags.sandbox, { apiKey: e2bApiKey() });
  const runtime = await boxRuntime(sandbox);
  const projectDir = `${runtime.claudeDir}/projects/${claudeProjectDirName(BOX_WORKSPACE)}`;
  const sessionId =
    flags.session ??
    (await sandbox.commands.run(`ls -t ${projectDir}/*.jsonl | head -n 1`)).stdout
      .trim()
      .replace(/^.*\/|\.jsonl$/g, "");
  if (!sessionId) throw new Error(`no Claude session in ${projectDir}`);

  const commit = (
    await sandbox.commands.run(`sh -c '${SNAPSHOT_SCRIPT.replaceAll("'", `'\\''`)}'`, {
      cwd: BOX_WORKSPACE,
      envs: {
        ...runtime.env,
        MOVE_CHAT_MESSAGE: `move-chat: snapshot of the box for ${sessionId}`,
      },
    })
  ).stdout.trim();
  const branch = `handoff/move-back-${sessionId.slice(0, 8)}-${commit.slice(0, 8)}`;
  await sandbox.commands.run(`git push --quiet origin ${commit}:refs/heads/${branch}`, {
    cwd: BOX_WORKSPACE,
    envs: runtime.env,
  });
  log(`box workspace at ${commit} pushed to ${branch}`);

  const text = await sandbox.files.read(`${projectDir}/${sessionId}.jsonl`);
  const target = claudeSessionPath({
    configDir: flags.claudeConfigDir,
    cwd: flags.worktree,
    sessionId,
  });
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  if (NodeFS.existsSync(target)) NodeFS.copyFileSync(target, `${target}.before-move-${Date.now()}`);
  NodeFS.writeFileSync(target, rewriteSessionCwd(text, BOX_WORKSPACE, flags.worktree));
  log(`session ${sessionId} written to ${target}`);
  sh(flags.worktree, "git", "fetch", "--quiet", "origin", branch);
  console.log(
    [
      "Resume it here:",
      `  cd ${flags.worktree}`,
      `  git switch -c ${branch} FETCH_HEAD   # or merge FETCH_HEAD into your branch`,
      `  CLAUDE_CONFIG_DIR=${flags.claudeConfigDir} claude --resume ${sessionId}`,
    ].join("\n"),
  );
}

/** An S3 object's text, read with this Mac's AWS credentials. */
const readS3 = (uri: string) =>
  NodeChildProcess.execFileSync("aws", ["s3", "cp", "--only-show-errors", uri, "-"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });

function configuredOutputsUri(): string | undefined {
  const path = NodePath.join(NodeOS.homedir(), ".t3", "environment-control.json");
  if (!NodeFS.existsSync(path)) return undefined;
  return JSON.parse(NodeFS.readFileSync(path, "utf8")).provisioning?.workerForks?.outputsUri;
}

async function restore(flags: {
  environment: string;
  uri: string;
  account: string | undefined;
  message: string | undefined;
  origin: string;
  bearer: string;
  watchMinutes: number;
  dryRun: boolean;
}) {
  const prefix = backupUri(flags.uri, flags.environment);
  const manifest = decodeBackupManifest(readS3(`${prefix}manifest.json`));
  const plan = planRestore(manifest, prefix);
  log(
    `backup of ${flags.environment}: ${plan.repository}@${plan.branch}, session ${plan.sessionId}`,
  );
  if (flags.dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  await continueOnBox({
    stateKey: `restore-${flags.environment}`,
    account: flags.account ?? manifest.account,
    repository: plan.repository,
    branch: plan.branch,
    sessionId: plan.sessionId,
    sessionText: rewriteSessionCwd(
      readS3(`${prefix}${plan.transcript}`),
      manifest.workspace,
      BOX_WORKSPACE,
    ),
    title: plan.title,
    modelSelection: decodeModelSelection(manifest.modelSelection),
    header: `Restored from the backup of environment ${flags.environment}: Claude session ${plan.sessionId}, checkout ${plan.branch}. Reply with only: ok`,
    text: flags.message ? `${plan.message}\n\n${flags.message}` : plan.message,
    origin: flags.origin,
    bearer: flags.bearer,
    watchMinutes: flags.watchMinutes,
  });
}

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    thread: { type: "string" },
    message: { type: "string" },
    "message-file": { type: "string" },
    include: { type: "string", multiple: true, default: [] },
    "include-cap-mb": { type: "string", default: "50" },
    "watch-minutes": { type: "string", default: "20" },
    "dry-run": { type: "boolean", default: false },
    "t3-home": { type: "string", default: NodePath.join(NodeOS.homedir(), ".t3") },
    "bearer-file": {
      type: "string",
      default: NodePath.join(
        NodeOS.homedir(),
        ".t3",
        "audit",
        "secrets",
        "host-pairing-token.bearer.json",
      ),
    },
    origin: { type: "string" },
    sandbox: { type: "string" },
    worktree: { type: "string" },
    "claude-config-dir": { type: "string", default: NodePath.join(NodeOS.homedir(), ".claude") },
    session: { type: "string" },
    environment: { type: "string" },
    uri: { type: "string" },
    account: { type: "string" },
    "no-carry": { type: "boolean", default: false },
    "carry-item-cap-mb": { type: "string", default: "1024" },
    "carry-total-cap-mb": { type: "string", default: "2048" },
  },
});
const carryCaps = {
  itemBytes: Number(values["carry-item-cap-mb"]) * 1024 * 1024,
  totalBytes: Number(values["carry-total-cap-mb"]) * 1024 * 1024,
};

if (positionals[0] === "to-cloud") {
  const bearer = JSON.parse(NodeFS.readFileSync(values["bearer-file"], "utf8")) as {
    origin: string;
    accessToken: string;
  };
  const text =
    values.message ??
    (values["message-file"] ? NodeFS.readFileSync(values["message-file"], "utf8") : null);
  if (!values.thread || !text)
    throw new Error("to-cloud needs --thread and --message or --message-file");
  await toCloud({
    thread: values.thread,
    text,
    t3Home: values["t3-home"],
    origin: values.origin ?? bearer.origin,
    bearer: bearer.accessToken,
    include: values.include,
    includeCapBytes: Number(values["include-cap-mb"]) * 1024 * 1024,
    watchMinutes: Number(values["watch-minutes"]),
    dryRun: values["dry-run"],
    carryCaps: values["no-carry"] ? null : carryCaps,
  });
} else if (positionals[0] === "to-local") {
  if (!values.sandbox || !values.worktree)
    throw new Error("to-local needs --sandbox and --worktree");
  await toLocal({
    sandbox: values.sandbox,
    worktree: NodePath.resolve(values.worktree),
    claudeConfigDir: NodePath.resolve(values["claude-config-dir"]),
    session: values.session,
  });
} else if (positionals[0] === "carry") {
  if (!values.sandbox || !values.thread) throw new Error("carry needs --sandbox and --thread");
  const local = readLocalChat(values.thread, values["t3-home"]);
  const carry = planLocalCarry(local, claudeSessionPath(local), carryCaps);
  if (!values["dry-run"]) {
    const sandbox = await Sandbox.connect(values.sandbox, { apiKey: e2bApiKey() });
    await uploadCarry(sandbox, (await boxRuntime(sandbox)).claudeDir, carry);
  }
} else if (positionals[0] === "restore") {
  const uri = values.uri ?? configuredOutputsUri();
  if (!values.environment || !uri)
    throw new Error(
      "restore needs --environment, and --uri when the host config has no outputsUri",
    );
  const bearer = JSON.parse(NodeFS.readFileSync(values["bearer-file"], "utf8")) as {
    origin: string;
    accessToken: string;
  };
  await restore({
    environment: values.environment,
    uri,
    account: values.account,
    message: values.message,
    origin: values.origin ?? bearer.origin,
    bearer: bearer.accessToken,
    watchMinutes: Number(values["watch-minutes"]),
    dryRun: values["dry-run"],
  });
} else {
  console.error(
    "usage: move-chat.ts to-cloud --thread <id> --message-file <file> | to-local --sandbox <id> --worktree <dir> | carry --sandbox <id> --thread <id> | restore --environment <id>",
  );
  process.exitCode = 2;
}
