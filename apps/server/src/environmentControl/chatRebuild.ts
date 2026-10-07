// @effect-diagnostics globalDate:off cryptoRandomUUID:off - a rebuild runs on the Promise side of the host and mints one-off command ids.
/**
 * Rebuilds a cloud chat on a fresh box from its last backup when its own box cannot be started:
 * the box restores the work from the backup with its own AWS keys, the host imports the chat's
 * Claude session there over the box's RPC, and the chat is told why it moved and what did not
 * come back. The old box is never touched; it stays paused for its provider to recover.
 *
 * @module chatRebuild
 */
import {
  CloudBackupManifest,
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationV2ProviderSession,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { planCloudRestore, type CloudRestorePlan } from "@t3tools/shared/cloudRestore";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { BoxRpc } from "./BoxFleetClient.ts";
import { agentEnvironmentPython } from "./guestAgentEnvironment.ts";
import type { RemotePreparationPort } from "./remotePreparation.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
/** The Claude instance a fresh box runs its chats on. */
const BOX_CLAUDE_INSTANCE = defaultInstanceIdForDriver(CLAUDE);

const restoreScript = String.raw`
import base64, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time
${agentEnvironmentPython}
request = json.load(sys.stdin)
root = pathlib.Path(request['root'])
workspace = root / 'workspace'
env, _server, _home, settings = agent_env(root)
env.update({'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': os.devnull, 'SSH_ASKPASS': os.devnull})
if request.get('token'):
    env.update({'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + request['token']).encode()).decode()})

def finish(result):
    print(json.dumps(result))
    sys.exit(0)

def fail(reason, result=None):
    tail = result.stderr.decode(errors='replace')[-300:].strip() if result is not None else ''
    finish({'kind': 'failed', 'reason': reason + (': ' + tail if tail else '')})

aws = shutil.which('aws', path=env.get('PATH')) or '/home/user/.local/bin/aws'
def fetch_object(key, target):
    result = subprocess.run([aws, 's3', 'cp', '--only-show-errors', request['uri'] + key, str(target)], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=600)
    if result.returncode != 0:
        fail('The backup has no readable ' + key, result)

def git(*args):
    result = subprocess.run(['git', *args], cwd=str(workspace), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
    if result.returncode != 0:
        fail('git ' + args[0] + ' failed', result)
    return result.stdout.decode().strip()

def claude_dir():
    return provider_home(env, settings, root, 'claudeAgent', request.get('instanceId', 'claudeAgent'))

mode = request['mode']
if mode == 'manifest':
    with tempfile.TemporaryDirectory() as scratch:
        fetch_object('manifest.json', pathlib.Path(scratch) / 'manifest.json')
        finish({'kind': 'manifest', 'manifest': json.loads((pathlib.Path(scratch) / 'manifest.json').read_text())})

if mode == 'restore':
    plan = request['plan']
    checkout = plan['checkout']
    current = subprocess.run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], cwd=str(workspace), stdout=subprocess.PIPE).stdout.decode().strip()
    if plan['bundle']:
        # A shallow clone may lack the commits the bundle builds on.
        if (workspace / '.git' / 'shallow').exists():
            git('fetch', '-q', '--unshallow', 'origin')
        with tempfile.TemporaryDirectory() as scratch:
            bundle = pathlib.Path(scratch) / 'work.bundle'
            fetch_object(plan['bundle'], bundle)
            git('fetch', '-q', str(bundle), 'refs/t3-bundle/*:refs/heads/*')
        if current != checkout:
            git('switch', '-q', checkout)
    elif current != checkout:
        git('fetch', '-q', 'origin', '+refs/heads/' + checkout + ':refs/remotes/origin/' + checkout)
        git('switch', '-q', '-C', checkout, 'origin/' + checkout)
    projects = claude_dir() / 'projects'
    session = plan['sessionId']
    moved = root / 'backup' / ('restored-' + session + '.jsonl')
    moved.parent.mkdir(parents=True, exist_ok=True)
    fetch_object(plan['transcript'], moved)
    old = json.dumps(request['oldWorkspace'])[1:-1]
    new = json.dumps(str(workspace))[1:-1]
    text = re.sub('"cwd":"' + re.escape(old) + '(?=["/])', lambda _: '"cwd":"' + new, moved.read_text())
    moved.write_text(text)
    # The importer finds a session by the cwd inside it from any project folder; staged apart
    # from the workspace's own folder, the first turn there opens a fresh session.
    staged = projects / 't3-move-chat-staging' / (session + '.jsonl')
    staged.parent.mkdir(parents=True, exist_ok=True)
    staged.write_text(text)
    final = projects / re.sub('[^a-zA-Z0-9]', '-', str(workspace)) / (session + '.jsonl')
    finish({'kind': 'restored', 'staged': str(staged), 'final': str(final), 'moved': str(moved)})

if mode == 'unstage':
    pathlib.Path(request['staged']).unlink(missing_ok=True)
    finish({'kind': 'done'})

if mode == 'swap':
    # The header turn's Claude process must be gone before its transcript is replaced.
    session = request['sessionId']
    deadline = time.monotonic() + 120
    def running():
        for cmdline in pathlib.Path('/proc').glob('[0-9]*/cmdline'):
            try:
                if session.encode() in cmdline.read_bytes():
                    return True
            except OSError:
                pass
        return False
    while running():
        if time.monotonic() > deadline:
            finish({'kind': 'failed', 'reason': "The header turn's Claude process did not exit."})
        time.sleep(1)
    final = pathlib.Path(request['final'])
    final.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(request['moved'], final)
    finish({'kind': 'done'})
`;

const RestoreAnswer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manifest"), manifest: CloudBackupManifest }),
  Schema.Struct({
    kind: Schema.Literal("restored"),
    staged: Schema.String,
    final: Schema.String,
    moved: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("done") }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
]);
const decodeRestoreAnswer = Schema.decodeUnknownExit(Schema.fromJsonString(RestoreAnswer));

const runRestoreStep = async (port: RemotePreparationPort, request: Record<string, unknown>) => {
  const result = await port.executePython({
    script: restoreScript,
    stdin: JSON.stringify(request),
  });
  const decoded = result.exitCode === 0 ? decodeRestoreAnswer(result.stdout.trim()) : null;
  if (decoded?._tag !== "Success")
    throw new Error(`The restore step ${String(request.mode)} did not finish.`);
  if (decoded.value.kind === "failed") throw new Error(decoded.value.reason);
  return decoded.value;
};

/** The steps a fresh box takes to become its chat's old box again, run on that box. */
export const makeBoxRestore = (
  port: RemotePreparationPort,
  input: { readonly root: string; readonly uri: string; readonly token?: string | undefined },
) => ({
  readManifest: async (): Promise<CloudBackupManifest> => {
    const answer = await runRestoreStep(port, { ...input, mode: "manifest" });
    if (answer.kind !== "manifest") throw new Error("The backup's manifest could not be read.");
    return answer.manifest;
  },
  /** Fetches the work onto `plan.checkout` and stages the chat's Claude session for import. */
  restoreWork: async (plan: CloudRestorePlan, oldWorkspace: string) => {
    const answer = await runRestoreStep(port, { ...input, mode: "restore", plan, oldWorkspace });
    if (answer.kind !== "restored") throw new Error("The backup's work could not be restored.");
    return answer;
  },
  unstage: (staged: string) => runRestoreStep(port, { ...input, mode: "unstage", staged }),
  /** Puts the moved history in the session's own file once the header turn's process is gone. */
  swap: (sessionId: string, files: { readonly final: string; readonly moved: string }) =>
    runRestoreStep(port, { ...input, mode: "swap", sessionId, ...files }),
});
export type BoxRestore = ReturnType<typeof makeBoxRestore>;

const SETTLED_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

const threadProjection = (rpc: BoxRpc, threadId: ThreadId) =>
  rpc["orchestration.subscribeThread"]({ threadId }).pipe(
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

/** Sends a message to a chat on the box and waits up to 15 minutes for its run to settle. */
const sendAndSettle = (
  rpc: BoxRpc,
  input: {
    readonly threadId: ThreadId;
    readonly text: string;
    readonly modelSelection: ModelSelection;
  },
) =>
  Effect.gen(function* () {
    const messageId = MessageId.make(crypto.randomUUID());
    yield* rpc["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: CommandId.make(crypto.randomUUID()),
      createdBy: "user",
      creationSource: "web",
      threadId: input.threadId,
      messageId,
      text: input.text,
      attachments: [],
      modelSelection: input.modelSelection,
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
    return yield* threadProjection(rpc, input.threadId).pipe(
      Effect.map((projection) => {
        const run = projection?.runs.findLast((candidate) => candidate.userMessageId === messageId);
        return projection && run && SETTLED_RUN.has(run.status) ? { projection, run } : null;
      }),
      Effect.repeat({
        until: (settled) => settled !== null,
        schedule: Schedule.spaced("5 seconds"),
      }),
      Effect.timeout("15 minutes"),
    );
  });

/**
 * Imports the chat's staged Claude session on the box and sends `message`, as move-chat's to-cloud
 * does: an imported Claude thread's first turn opens a fresh native session under the session's
 * id, so a header turn opens it, its process is let go, and the moved history replaces what it
 * wrote. Answers the box's thread for the chat.
 */
export const continueChatOnBox = (
  rpc: BoxRpc,
  restore: BoxRestore,
  input: {
    readonly workspace: string;
    readonly plan: CloudRestorePlan;
    readonly files: { readonly staged: string; readonly final: string; readonly moved: string };
    readonly modelSelection: ModelSelection;
  },
) =>
  Effect.gen(function* () {
    const { plan } = input;
    const threadId = ThreadId.make(`import:${BOX_CLAUDE_INSTANCE}:${plan.sessionId}`);
    const selection = { ...input.modelSelection, instanceId: BOX_CLAUDE_INSTANCE };
    const project = yield* rpc["orchestration.subscribeShell"]({}).pipe(
      Stream.flatMap((item) =>
        Stream.fromIterable(item.kind === "snapshot" ? item.snapshot.projects : []),
      ),
      Stream.filter((candidate) => candidate.workspaceRoot === input.workspace),
      Stream.runHead,
      Effect.timeoutOption("3 minutes"),
      Effect.map(Option.flatten),
    );
    if (Option.isNone(project))
      return yield* Effect.fail(new Error(`The new box has no project at ${input.workspace}.`));
    yield* rpc["server.getConfig"]({}).pipe(
      Effect.map((config) =>
        config.providers.some(
          (provider) => provider.instanceId === BOX_CLAUDE_INSTANCE && provider.models.length > 0,
        ),
      ),
      Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("3 seconds") }),
      Effect.timeout("3 minutes"),
    );
    yield* rpc["agentSessions.scan"]({});
    yield* rpc["agentSessions.import"]({
      projectId: project.value.id,
      expectedWorkspaceRoot: input.workspace,
    });
    yield* Effect.tryPromise(() => restore.unstage(input.files.staged));
    if ((yield* threadProjection(rpc, threadId)) === null)
      return yield* Effect.fail(new Error(`The new box did not import session ${plan.sessionId}.`));
    yield* rpc["orchestration.dispatchCommand"]({
      type: "thread.metadata.update",
      commandId: CommandId.make(crypto.randomUUID()),
      threadId,
      title: plan.title,
    });
    // The importer files history as settled; this chat is live.
    yield* rpc["orchestration.dispatchCommand"]({
      type: "thread.unsettle",
      commandId: CommandId.make(crypto.randomUUID()),
      threadId,
      reason: "user",
    });
    const header = yield* sendAndSettle(rpc, {
      threadId,
      text: `Rebuilt from a backup: continues Claude session ${plan.sessionId} on ${plan.checkout}. Reply with only: ok`,
      modelSelection: selection,
    });
    if (header === null)
      return yield* Effect.fail(new Error("The header turn on the new box did not settle."));
    const sessions: ReadonlyArray<OrchestrationV2ProviderSession> =
      header.projection.providerSessions;
    for (const session of sessions.filter((candidate) => candidate.status !== "stopped"))
      yield* rpc["orchestration.dispatchCommand"]({
        type: "provider-session.detach",
        commandId: CommandId.make(crypto.randomUUID()),
        threadId,
        providerSessionId: session.id,
        reason: "rebuild: reopen the restored native session",
      });
    yield* Effect.tryPromise(() => restore.swap(plan.sessionId, input.files));
    yield* rpc["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: CommandId.make(crypto.randomUUID()),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId: MessageId.make(crypto.randomUUID()),
      text: plan.message,
      attachments: [],
      modelSelection: selection,
      deliveryIntent: "auto",
      dispatchMode: { type: "start_immediately" },
    });
    return threadId;
  });

export const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);

/** Plans a chat's rebuild from its manifest; the why tells the agent its machine was replaced. */
export const planRebuild = (manifest: CloudBackupManifest, uri: string) =>
  planCloudRestore(
    manifest,
    uri,
    "E2B could not start that machine for a long time, so T3 rebuilt the chat on a new one. The old machine is kept paused in case E2B recovers it.",
  );
