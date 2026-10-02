/**
 * Pushes a cloud chat's unsaved git work to `t3-backup/` branches on its origin before the machine
 * holding it is removed. Runs on the guest as one Python script: JSON in on stdin, one JSON line
 * out. Builds its commits from copies of each index, so the checkout an agent may resume in is
 * never written.
 *
 * @module workspaceBackup
 */
import * as Schema from "effect/Schema";

import type { RemotePreparationPort } from "./remotePreparation.ts";

const workspaceBackupScript = String.raw`
import base64, json, os, pathlib, subprocess, sys, tempfile

request = json.load(sys.stdin)
# Resolved, so it compares equal to the real paths git lists worktrees at.
root = pathlib.Path(request['root']).resolve()
main = root / 'workspace'
env = dict(os.environ)
env.update({
    'GIT_AUTHOR_NAME': 'T3', 'GIT_AUTHOR_EMAIL': 'agent@t3.local',
    'GIT_COMMITTER_NAME': 'T3', 'GIT_COMMITTER_EMAIL': 'agent@t3.local',
    'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': os.devnull, 'SSH_ASKPASS': os.devnull,
    'GCM_INTERACTIVE': 'never',
    # Keeps git status from refreshing, and so rewriting, a real index.
    'GIT_OPTIONAL_LOCKS': '0',
})
if request.get('token'):
    env.update({'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + request['token']).encode()).decode()})

def finish(result):
    print(json.dumps(result))
    sys.exit(0)

def git(cwd, *args, extra=None):
    return subprocess.run(['git', *args], cwd=str(cwd), env={**env, **(extra or {})}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

def out(cwd, *args, extra=None):
    result = git(cwd, *args, extra=extra)
    if result.returncode != 0:
        finish({'kind': 'unsaved', 'reason': 'git ' + args[0] + ' failed.'})
    return result.stdout.decode().strip()

if not main.is_dir() or not any(main.iterdir()):
    finish({'kind': 'clean'})
if not (main / '.git').is_dir():
    finish({'kind': 'unsaved', 'reason': 'The workspace is not a git repository.'})

def list_trees():
    trees, entry = [], {}
    for line in out(main, 'worktree', 'list', '--porcelain').splitlines() + ['']:
        if line:
            key, _, value = line.partition(' ')
            entry[key] = value
            continue
        path = pathlib.Path(entry['worktree']) if entry.get('worktree') else None
        if path and 'prunable' not in entry and path.is_dir():
            if path == main:
                trees.insert(0, path)
            elif root in path.parents:
                trees.append(path)
            else:
                finish({'kind': 'unsaved', 'reason': "A worktree lives outside the chat's root."})
        entry = {}
    return trees

def head(tree):
    return git(tree, 'rev-parse', '-q', '--verify', 'HEAD^{commit}').stdout.decode().strip() or None

def snapshot(tree, commit):
    # A copy of the index takes every change, untracked files included, without touching the real one.
    with tempfile.TemporaryDirectory() as scratch:
        index = pathlib.Path(scratch) / 'index'
        real = tree / out(tree, 'rev-parse', '--git-path', 'index')
        if real.is_file():
            index.write_bytes(real.read_bytes())
        extra = {'GIT_INDEX_FILE': str(index)}
        out(tree, 'add', '-A', extra=extra)
        written = out(tree, 'write-tree', extra=extra)
    # Dated like HEAD, so a rerun over the same tree pushes the same commit.
    date = out(tree, 'log', '-1', '--format=%cI', commit) if commit else '@0 +0000'
    parents = ['-p', commit] if commit else []
    return out(tree, 'commit-tree', written, *parents, '-m', 'T3 backup of unsaved work', extra={'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date})

def unpushed(commit):
    return commit is not None and out(main, 'rev-list', '--count', commit, '--not', '--remotes') != '0'

name = 't3-backup/' + request['branch']
pending = []
for index, tree in enumerate(list_trees()):
    commit = head(tree)
    dirty = out(tree, 'status', '--porcelain=v1', '-z', '--untracked-files=all') != ''
    if dirty and (tree / '.gitmodules').exists():
        finish({'kind': 'unsaved', 'reason': "A submodule's changes cannot be backed up."})
    if dirty or unpushed(commit):
        pending.append((name if index == 0 else name + '-' + str(index), tree, commit, dirty))
# A branch an agent committed on and then left is in no tree. Named by position, never by the
# branch's own name, so two branches can never land on one backup.
heads = out(main, 'for-each-ref', '--format=%(objectname)', 'refs/heads/').splitlines()
for index, commit in enumerate(heads):
    if unpushed(commit):
        pending.append((name + '-branch-' + str(index), None, commit, False))
stashes = out(main, 'stash', 'list', '--format=%H').splitlines()

if not pending and not stashes:
    finish({'kind': 'clean'})
if not request['push']:
    finish({'kind': 'unsaved', 'reason': 'The work is not pushed and no GitHub token can push it.'})
if git(main, 'remote', 'get-url', 'origin').returncode != 0:
    finish({'kind': 'unsaved', 'reason': 'The checkout has no origin remote to push to.'})

refs = {}
for branch, tree, commit, dirty in pending:
    refs[branch] = snapshot(tree, commit) if dirty else commit
for index, commit in enumerate(stashes):
    refs[name + '-stash-' + str(index)] = commit

if git(main, 'push', '--force', '--no-verify', '--quiet', 'origin', *(commit + ':refs/heads/' + branch for branch, commit in refs.items())).returncode != 0:
    finish({'kind': 'unsaved', 'reason': 'The backup push failed.'})
listed = git(main, 'ls-remote', 'origin', *('refs/heads/' + branch for branch in refs))
remote = {}
for line in listed.stdout.decode().splitlines():
    commit, _, ref = line.partition('\t')
    remote[ref] = commit
if listed.returncode != 0 or any(remote.get('refs/heads/' + branch) != commit for branch, commit in refs.items()):
    finish({'kind': 'unsaved', 'reason': 'The backup branches did not verify on origin.'})
finish({'kind': 'saved', 'branches': list(refs)})
`;

export const WorkspaceBackup = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("clean") }),
  Schema.Struct({ kind: Schema.Literal("saved"), branches: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("unsaved"), reason: Schema.String }),
]);
export type WorkspaceBackup = typeof WorkspaceBackup.Type;
const decodeBackup = Schema.decodeUnknownExit(Schema.fromJsonString(WorkspaceBackup));

/**
 * Whether the chat under `root` has git work only its machine holds, and pushes it when it does
 * and `push` allows. Every tree with changes or unpushed commits goes to `t3-backup/<branch>`
 * (`-<n>` for the n-th worktree), every local branch with unpushed commits to
 * `t3-backup/<branch>-branch-<n>` (its position among the sorted branches), and every stash entry to
 * `t3-backup/<branch>-stash-<n>`. A worktree outside `root`, or a changed tree with submodules,
 * is `unsaved`. `saved` means each branch was read back from origin at the pushed commit. A rerun
 * pushes the same commits to the same branches.
 */
export async function backUpWorkspace(
  port: RemotePreparationPort,
  input: {
    readonly root: string;
    readonly branch: string;
    readonly push: boolean;
    readonly token?: string | undefined;
  },
): Promise<WorkspaceBackup> {
  const result = await port.executePython({
    script: workspaceBackupScript,
    stdin: JSON.stringify(input),
  });
  const decoded = result.exitCode === 0 ? decodeBackup(result.stdout.trim()) : null;
  return decoded?._tag === "Success"
    ? decoded.value
    : { kind: "unsaved", reason: "The backup did not finish." };
}
