/**
 * Moves a chat between this Mac and a cloud box with its agent's memory: the checkout exactly as
 * it is on disk, and the agent's native Claude session, so the agent continues the same
 * conversation instead of reading a summary of it.
 *
 *   node scripts/cloud/move-chat.ts to-cloud --thread <local thread id> --message-file first.md \
 *     [--include .env --include-cap-mb 50]
 *   node scripts/cloud/move-chat.ts to-local --sandbox <e2b sandbox id> --worktree <dir> \
 *     --claude-config-dir ~/.claude
 *
 * to-cloud reads the local desktop app's database read-only, pushes the snapshot to
 * `handoff/move-*`, provisions an E2B box on the manager for it, imports the session there with
 * the box's own agent session importer, and sends the first message. Re-running it with the same
 * thread picks up where an interrupted run stopped.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";
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
import { FetchHttpClient } from "effect/unstable/http";

import {
  claudeProjectDirName,
  claudeSessionPath,
  githubRepository,
  rewriteSessionCwd,
  SNAPSHOT_SCRIPT,
  snapshotCheckout,
} from "./moveChat.ts";
import { childPairingUrl, exchangePairingToken, type T3Client, withRpc } from "./t3Rpc.ts";
import { advanceTurn, initialProgress, type TurnProgress } from "./turnProgress.ts";

const BOX_WORKSPACE = "/home/user/.t3-provision/workspace";
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const BOX_INSTANCE = defaultInstanceIdForDriver(CLAUDE);
const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
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
}) {
  const local = readLocalChat(flags.thread, flags.t3Home);
  if (local.running)
    throw new Error(`"${local.title}" is running locally; stop it before moving it`);
  const sessionFile = claudeSessionPath(local);
  if (!NodeFS.existsSync(sessionFile)) throw new Error(`no Claude session at ${sessionFile}`);
  const repository = githubRepository(sh(local.cwd, "git", "remote", "get-url", "origin"));
  if (!repository) throw new Error(`${local.cwd} has no GitHub origin`);

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

  const state = loadState(local.threadId);
  saveState(local.threadId, state);
  const boxThreadId = ThreadId.make(`import:${BOX_INSTANCE}:${local.sessionId}`);
  const selection = { ...local.modelSelection, instanceId: BOX_INSTANCE };
  const sessionText = NodeFS.readFileSync(sessionFile, "utf8");
  const movedText = rewriteSessionCwd(sessionText, local.cwd, BOX_WORKSPACE);
  const boxSession = (claudeDir: string) =>
    claudeSessionPath({ configDir: claudeDir, cwd: BOX_WORKSPACE, sessionId: local.sessionId });
  // The importer finds a session by the cwd inside it, from any project directory. Staging it
  // away from the workspace's own directory lets the first turn create a fresh session there.
  const stagedSession = (claudeDir: string) =>
    `${claudeDir}/projects/t3-move-chat-staging/${local.sessionId}.jsonl`;

  const program = Effect.gen(function* () {
    const box = yield* withRpc(flags.origin, flags.bearer, (manager) =>
      Effect.gen(function* () {
        const config = yield* manager["server.getConfig"]({});
        if (!config.providers.some((provider) => provider.instanceId === local.instanceId))
          return yield* Effect.fail(new Error(`the manager has no account ${local.instanceId}`));
        const ready = yield* manager["environmentControl.provision"]({
          requestId: ProvisionRequestId.make(state.requestId),
          provider: "e2b",
          agentDriver: CLAUDE,
          providerInstanceId: local.instanceId,
          pinAccount: true,
          repository,
          branch,
          chat: { threadId: boxThreadId },
        }).pipe(
          Effect.tap((result) => Effect.sync(() => log(`provision: ${result.kind}`))),
          Effect.repeat({
            while: (result) => result.kind === "pending" || result.kind === "allocation_unknown",
            schedule: Schedule.spaced("10 seconds"),
          }),
        );
        if (ready.kind !== "ready")
          return yield* Effect.fail(new Error(`provision ${ready.kind}: ${ready.message}`));
        const attached = yield* manager["environmentControl.attach"]({
          requestId: ProvisionRequestId.make(state.requestId),
        });
        if (attached.kind !== "attached")
          return yield* Effect.fail(new Error(`attach refused: ${attached.message}`));
        const { pairingUrl } = childPairingUrl({
          attachedPairingUrl: new URL(attached.pairingUrl),
          origin: flags.origin,
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
    saveState(local.threadId, state);
    log(`box ${box.environment.sandboxId} (environment ${box.environment.environmentId})`);

    const sandbox = yield* Effect.promise(() =>
      Sandbox.connect(box.environment.sandboxId, { apiKey: e2bApiKey() }),
    );
    const runtime = yield* Effect.promise(() => boxRuntime(sandbox));
    log(`box Claude config ${runtime.claudeDir}`);
    if (extras) {
      yield* Effect.promise(async () => {
        await sandbox.files.write("/tmp/move-chat-extras.tgz", new Blob([extras]));
        await sandbox.commands.run(`tar -xzf /tmp/move-chat-extras.tgz -C ${BOX_WORKSPACE}`);
      });
      log(`copied ${flags.include.join(", ")} into the box workspace`);
    }

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
              new Error(`the box did not import session ${local.sessionId}`),
            );
          yield* client["orchestration.dispatchCommand"]({
            type: "thread.metadata.update",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: boxThreadId,
            title: local.title,
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
            text: `Moved from the Mac: continues local thread "${local.title}" (${local.threadId}), Claude session ${local.sessionId}, checkout ${branch}. Reply with only: ok`,
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
                `ps -eo args= | grep -F -- '${local.sessionId}' | grep -vc grep || true`,
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
          saveState(local.threadId, state);
          log(`box session ${boxSession(runtime.claudeDir)} now holds the moved history`);
        }

        yield* client["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(state.commandId),
          createdBy: "user",
          creationSource: "web",
          threadId: boxThreadId,
          messageId: MessageId.make(state.messageId),
          text: flags.text,
          attachments: [],
          modelSelection: selection,
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        });
        const turn = yield* watchTurn(client, boxThreadId, state.messageId, flags.watchMinutes);
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
  },
});

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
} else {
  console.error(
    "usage: move-chat.ts to-cloud --thread <id> --message-file <file> | to-local --sandbox <id> --worktree <dir>",
  );
  process.exitCode = 2;
}
