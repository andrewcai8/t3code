// @effect-diagnostics globalTimers:off - the budget bounds a Promise-side backup the host does not own.
/**
 * Backs a cloud box up before it sleeps, so its chat can be restored on a fresh box if this one is
 * lost or never resumes: its unsaved git work goes to `t3-backup/` branches on origin, and its
 * owner chat's provider sessions plus a restore manifest go to S3 with the AWS credentials the
 * chat's agent has. The host never holds AWS keys for it. Each part skips itself when the box
 * holds what it held at the last backup.
 *
 * @module boxBackup
 */
import * as Schema from "effect/Schema";

import { agentEnvironmentPython } from "./guestAgentEnvironment.ts";
import type { LeaseBackup } from "./ProvisionedLeaseRegistry.ts";
import type { RemotePreparationPort } from "./remotePreparation.ts";
import { backUpWorkspace } from "./workspaceBackup.ts";

/** The manifest restore reads; `version` changes only with a change restore cannot read. */
export const BackupManifest = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  leaseId: Schema.String,
  /** The host account the box ran its chat on. */
  account: Schema.String,
  threadId: Schema.String,
  title: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(Schema.Unknown),
  workspace: Schema.String,
  repository: Schema.NullOr(Schema.String),
  /** The branch the workspace had checked out, and its commit. */
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  backupBranches: Schema.Array(Schema.String),
  /** The chat's provider sessions, oldest first, each with its files' keys under the backup. */
  sessions: Schema.Array(
    Schema.Struct({
      driver: Schema.String,
      instanceId: Schema.String,
      nativeId: Schema.String,
      files: Schema.Array(Schema.String),
    }),
  ),
});
export type BackupManifest = typeof BackupManifest.Type;

const sessionBackupScript = String.raw`
import hashlib, json, os, pathlib, re, shutil, sqlite3, subprocess, sys, tempfile
${agentEnvironmentPython}
request = json.load(sys.stdin)
root = pathlib.Path(request['root'])
chat = request['chat']
env, _server, t3home, settings = agent_env(root)
instances = settings.get('providerInstances') or {}

def finish(result):
    print(json.dumps(result))
    sys.exit(0)

def config_dir(driver, instance):
    home_path = ((instances.get(instance) or {}).get('config') or {}).get('homePath')
    if home_path:
        return pathlib.Path(home_path)
    variable, folder = ('CLAUDE_CONFIG_DIR', '.claude') if driver == 'claudeAgent' else ('CODEX_HOME', '.codex')
    return pathlib.Path(env.get(variable) or pathlib.Path(env.get('HOME', str(root / 'home'))) / folder)

try:
    db = sqlite3.connect('file:' + str(t3home / 'userdata' / 'statev2.sqlite') + '?mode=ro', uri=True)
    threads = db.execute('SELECT driver, provider_instance_id, payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? ORDER BY COALESCE(last_run_ordinal, 0), provider_thread_id', (chat['threadId'],)).fetchall()
    title = db.execute('SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ?', (chat['threadId'],)).fetchone()
    run = db.execute('SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1', (chat['threadId'],)).fetchone()
    db.close()
except sqlite3.Error:
    finish({'kind': 'failed', 'reason': "The chat's database could not be read."})

files = {}
sessions = []
for driver, instance, payload in threads:
    native = (json.loads(payload).get('nativeThreadRef') or {}).get('nativeId')
    if not isinstance(native, str) or not native or any(c in native for c in '/*?['):
        continue
    base = config_dir(driver, instance)
    if driver == 'claudeAgent':
        # The transcript, and beside it the folder of its subagents' transcripts and tool outputs.
        found = []
        for transcript in sorted((base / 'projects').glob('*/' + native + '.jsonl')):
            found.append(transcript)
            folder = transcript.with_suffix('')
            if folder.is_dir():
                found.extend(sorted(path for path in folder.rglob('*') if path.is_file()))
    elif driver == 'codex':
        found = sorted((base / 'sessions').rglob('rollout-*-' + native + '.jsonl'))
    else:
        continue
    keys = []
    for path in found:
        key = driver + '/' + str(path.relative_to(base))
        files[key] = path
        keys.append(key)
    sessions.append({'driver': driver, 'instanceId': instance, 'nativeId': native, 'files': keys})

workspace = root / 'workspace'
def git(*args):
    result = subprocess.run(['git', *args], cwd=str(workspace), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env={**env, 'GIT_OPTIONAL_LOCKS': '0'})
    return (result.stdout.decode().strip() or None) if result.returncode == 0 else None
has_git = (workspace / '.git').exists()
origin = git('remote', 'get-url', 'origin') if has_git else None
manifest = {
    'version': 1,
    'environmentId': chat['environmentId'],
    'leaseId': chat['leaseId'],
    'account': chat['account'],
    'threadId': chat['threadId'],
    'title': title[0] if title else None,
    'modelSelection': json.loads(run[0]).get('modelSelection') if run else None,
    'workspace': str(workspace),
    # Without any credential a URL may carry.
    'repository': re.sub(r'^(https?://)[^/@]*@', r'\1', origin) if origin else None,
    'branch': git('symbolic-ref', '--short', '-q', 'HEAD') if has_git else None,
    'head': git('rev-parse', '-q', '--verify', 'HEAD^{commit}') if has_git else None,
    'backupBranches': request['branches'],
    'sessions': sessions,
}
stats = []
for key, path in sorted(files.items()):
    stat = path.stat()
    stats.append([key, stat.st_size, stat.st_mtime_ns])
fingerprint = hashlib.sha256(json.dumps([manifest, stats], sort_keys=True).encode()).hexdigest()
if request.get('previous') == fingerprint:
    finish({'kind': 'unchanged'})

aws = shutil.which('aws', path=env.get('PATH')) or '/home/user/.local/bin/aws'
if not os.access(aws, os.X_OK):
    finish({'kind': 'failed', 'reason': 'The box has no AWS CLI to upload with.'})
with tempfile.TemporaryDirectory() as staging:
    for key, path in files.items():
        target = pathlib.Path(staging) / key
        target.parent.mkdir(parents=True, exist_ok=True)
        # Keeps each file's time, so sync uploads only the files that changed.
        shutil.copy2(path, target)
    (pathlib.Path(staging) / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    try:
        upload = subprocess.run([aws, 's3', 'sync', '--delete', '--only-show-errors', '--no-progress', staging, request['uri']], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=request['timeoutSeconds'])
    except subprocess.TimeoutExpired:
        finish({'kind': 'failed', 'reason': 'The session upload ran out of time.'})
if upload.returncode != 0:
    finish({'kind': 'failed', 'reason': 'The session upload failed: ' + upload.stderr.decode(errors='replace')[-300:].strip()})
finish({'kind': 'saved', 'files': sorted(files), 'fingerprint': fingerprint})
`;

const SessionBackup = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("saved"),
    files: Schema.Array(Schema.String),
    fingerprint: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("unchanged") }),
  Schema.Struct({ kind: Schema.Literal("failed"), reason: Schema.String }),
]);
type SessionBackup = typeof SessionBackup.Type;
const decodeSessionBackup = Schema.decodeUnknownExit(Schema.fromJsonString(SessionBackup));

/** Where a box's latest backup lives under the host's outputs bucket. */
export const backupUri = (outputsUri: string, environmentId: string) =>
  `${outputsUri.replace(/\/+$/, "")}/${environmentId}/backups/latest/`;

/**
 * Uploads the owner chat's provider session files and the restore manifest to `uri`, which then
 * holds exactly those: Claude's transcript with its subagent and tool-output folder, or Codex's
 * rollout file, of each provider thread the chat ran. Files of the box's other chats stay.
 */
export async function backUpSessions(
  port: RemotePreparationPort,
  input: {
    readonly root: string;
    readonly uri: string;
    readonly chat: {
      readonly environmentId: string;
      readonly leaseId: string;
      readonly account: string;
      readonly threadId: string;
    };
    readonly branches: ReadonlyArray<string>;
    readonly previous?: string | undefined;
    readonly timeoutSeconds: number;
  },
): Promise<SessionBackup> {
  const result = await port.executePython({
    script: sessionBackupScript,
    stdin: JSON.stringify(input),
  });
  const decoded = result.exitCode === 0 ? decodeSessionBackup(result.stdout.trim()) : null;
  return decoded?._tag === "Success"
    ? decoded.value
    : { kind: "failed", reason: "The session backup did not finish." };
}

/** A lease's next backup record, and what the backup could not save. */
export interface BoxBackupResult {
  readonly backup: LeaseBackup | undefined;
  readonly problems: ReadonlyArray<string>;
}

/**
 * `work`'s answer, or "timeout" once `budgetMs` passes first. Work still running then is left to
 * finish on its own; its failure is swallowed.
 */
export async function withinBudget<A>(work: Promise<A>, budgetMs: number): Promise<A | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  try {
    return await Promise.race([
      work,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), budgetMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs both parts of a box's backup and answers the lease's next record, with what could not be
 * saved. A part that fails keeps what the previous record said of it; an unchanged box answers
 * `previous` itself.
 */
export async function backUpBox(
  port: RemotePreparationPort,
  input: {
    readonly root: string;
    readonly leaseId: string;
    readonly push: boolean;
    readonly token?: string | undefined;
    /** The owner chat and where its sessions go; absent without an owner or outputs bucket. */
    readonly sessions?: {
      readonly uri: string;
      readonly environmentId: string;
      readonly account: string;
      readonly threadId: string;
    };
    readonly previous: LeaseBackup | undefined;
    readonly now: string;
    readonly timeoutSeconds: number;
  },
): Promise<BoxBackupResult> {
  const { previous } = input;
  const problems: Array<string> = [];
  const work = await backUpWorkspace(port, {
    root: input.root,
    branch: input.leaseId,
    push: input.push,
    token: input.token,
    previous: previous?.workFingerprint,
  });
  if (work.kind === "unsaved") problems.push(work.reason);
  const workPart =
    work.kind === "saved"
      ? { branches: work.branches, workFingerprint: work.fingerprint }
      : work.kind === "clean"
        ? { branches: [], workFingerprint: undefined }
        : work.kind === "unchanged"
          ? { branches: previous?.branches ?? [], workFingerprint: previous?.workFingerprint }
          : null;
  const branches = workPart?.branches ?? previous?.branches ?? [];
  let sessionPart: { sessionsUri: string; sessionsFingerprint: string | undefined } | null = null;
  if (input.sessions) {
    const { uri, ...chat } = input.sessions;
    const result = await backUpSessions(port, {
      root: input.root,
      uri,
      chat: { ...chat, leaseId: input.leaseId },
      branches,
      previous: previous?.sessionsUri === uri ? previous.sessionsFingerprint : undefined,
      timeoutSeconds: input.timeoutSeconds,
    });
    if (result.kind === "failed") problems.push(result.reason);
    else
      sessionPart = {
        sessionsUri: uri,
        sessionsFingerprint:
          result.kind === "saved" ? result.fingerprint : previous?.sessionsFingerprint,
      };
  }
  if (workPart === null && sessionPart === null) return { backup: previous, problems };
  const workFingerprint = workPart ? workPart.workFingerprint : previous?.workFingerprint;
  const sessionsUri = sessionPart?.sessionsUri ?? previous?.sessionsUri;
  const sessionsFingerprint = sessionPart
    ? sessionPart.sessionsFingerprint
    : previous?.sessionsFingerprint;
  const unchanged =
    previous !== undefined &&
    previous.branches.join("\n") === branches.join("\n") &&
    previous.workFingerprint === workFingerprint &&
    previous.sessionsUri === sessionsUri &&
    previous.sessionsFingerprint === sessionsFingerprint;
  if (unchanged) return { backup: previous, problems };
  return {
    backup: {
      at: input.now,
      branches,
      ...(sessionsUri === undefined ? {} : { sessionsUri }),
      ...(workFingerprint === undefined ? {} : { workFingerprint }),
      ...(sessionsFingerprint === undefined ? {} : { sessionsFingerprint }),
    },
    problems,
  };
}
