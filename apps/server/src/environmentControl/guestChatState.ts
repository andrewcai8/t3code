import * as Schema from "effect/Schema";

import { warmJournalKeys, type RemotePreparationPort } from "./remotePreparation.ts";

/**
 * Home-relative paths preparation rebuilds. One table, two uses: a snapshot
 * saves the home minus these, and a sealed template keeps only these. Because
 * the table lists what to drop rather than what to keep, a provider directory
 * nobody listed is saved, so forgetting one costs bytes, never a transcript.
 */
export const DERIVED_HOME_PATHS = [
  ".local/bin",
  ".local/lib",
  ".local/share/cursor-agent",
  ".npm",
  ".cache",
  ".bun/install/cache",
  "Library/Caches",
  "Library/Developer/Xcode/DerivedData",
  "go/pkg",
  ".rustup",
  ".cargo/registry",
  // Codex's app and plugin caches: about 58 MB of a fresh chat's 78 MB snapshot.
  ".codex/cache",
  ".codex/plugins/cache",
] as const;

/**
 * Guest verbs that move a chat between a Mac and its off-box snapshot and keep
 * the repository's cache template honest. JSON in on stdin, JSON out on
 * stdout, convergent when rerun after a crash at any point.
 *
 * The cache volume is mounted at `mount`; the chat's root is `mount/root`,
 * the same path on every Mac, because absolute paths are baked into the
 * journal, worktree links, venvs and build trees. The template is a sealed
 * copy of a pristine root at `mount/template`, valid only while
 * `mount/template.json` (written last) describes it.
 */
const guestChatStateScript = String.raw`
import base64, contextlib, fcntl, hashlib, io, json, os, pathlib, re, shutil, sqlite3, stat, subprocess, sys, tarfile, tempfile, time, urllib.request, uuid

os.umask(0o077)
FORMAT = 1
WARM_KEYS = ${JSON.stringify(warmJournalKeys)}
DERIVED_HOME = ${JSON.stringify(DERIVED_HOME_PATHS)}
# Thread worktrees live in the home but are saved through git with the repository.
GIT_SAVED_HOME = ['.t3/worktrees']
ROOT_FILES = ['preparation.json', 'broker-token']
# Ignored single files up to this size are a chat's own (.env.local); ignored
# directories (node_modules, build trees) are always derived.
IGNORED_FILE_MAX = 10 * 1024 * 1024
SQLITE_MAGIC = b'SQLite format 3\x00'
SNAPSHOT_REFS = 'refs/t3-snapshot/'
GIT_IDENTITY = {
    'GIT_AUTHOR_NAME': 'T3', 'GIT_AUTHOR_EMAIL': 'agent@t3.local',
    'GIT_COMMITTER_NAME': 'T3', 'GIT_COMMITTER_EMAIL': 'agent@t3.local',
    'GIT_TERMINAL_PROMPT': '0', 'GIT_ASKPASS': os.devnull, 'GCM_INTERACTIVE': 'never',
}
# Snapshot commits of an unchanged tree get the same ids on every save. Only
# these: git hides reflog entries stamped at the epoch, which would empty the stash.
FIXED_DATES = {'GIT_AUTHOR_DATE': '@0 +0000', 'GIT_COMMITTER_DATE': '@0 +0000'}

def fsync_dir(path):
    handle = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(handle)
    finally:
        os.close(handle)

def atomic(path, value):
    temp = path.with_name(path.name + '.tmp')
    with open(temp, 'w') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)
    fsync_dir(path.parent)

def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None

@contextlib.contextmanager
def locked(path):
    with open(path, 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield

def make_writable(func, path, _error):
    # Go writes its module cache read-only, and an entry only leaves a writable directory.
    # A chat may also have made files immutable (chflags uchg), which no chmod undoes.
    if hasattr(os, 'lchflags'):
        for target in (os.path.dirname(path), path):
            with contextlib.suppress(OSError):
                os.lchflags(target, 0)
    os.chmod(os.path.dirname(path), 0o700)
    if os.path.isdir(path) and not os.path.islink(path):
        os.chmod(path, 0o700)
    func(path)

def rmtree(path, ignore=False):
    try:
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=make_writable)
        else:
            shutil.rmtree(path, onerror=make_writable)
    except OSError:
        if not ignore:
            raise

def remove(path):
    if path.is_symlink() or path.is_file():
        try:
            path.unlink()
        except PermissionError:
            make_writable(os.unlink, str(path), None)
    elif path.exists():
        rmtree(path)

def trash(mount, path, wait=False):
    # A rename is instant and atomic; the delete of a large tree is not.
    target = mount / ('trash-' + uuid.uuid4().hex)
    os.rename(path, target)
    fsync_dir(mount)
    if wait:
        rmtree(target)
    else:
        subprocess.Popen(['sh', '-c', 'chmod -R u+w "$1" 2>/dev/null; rm -rf "$1"', 'sh', str(target)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def contained(base, relative):
    parts = pathlib.PurePosixPath(relative).parts
    if not parts or pathlib.PurePosixPath(relative).is_absolute() or any(part in ('..', '') for part in parts):
        raise RuntimeError('Path escapes its directory: ' + relative)
    return base.joinpath(*parts)

def git_env(extra=None):
    env = dict(os.environ)
    env.update(GIT_IDENTITY)
    env.update(extra or {})
    return env

def git(cwd, *args, env=None, check=True, data=None):
    result = subprocess.run(['git', *args], cwd=str(cwd), env=env or git_env(), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).decode(errors='replace').strip()
        raise RuntimeError('git ' + ' '.join(args[:3]) + ' failed: ' + detail[-1500:])
    return result

def out(cwd, *args, **options):
    return git(cwd, *args, **options).stdout.decode().strip()

def server_lock_free(root):
    with open(root / 'server.lock', 'a') as held:
        try:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True

def stop_server(root):
    try:
        pid = json.loads((root / 'server.json').read_text())['pid']
    except (OSError, ValueError, KeyError):
        return
    for signal, grace in ((15, 30), (9, 10)):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal)
        deadline = time.monotonic() + grace
        while not server_lock_free(root):
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        else:
            return
    raise RuntimeError('The T3 server did not stop for the save')

def excluded(rel, paths):
    return any(rel == path or rel.startswith(path + '/') for path in paths)

def walk(base, skip):
    # Sorted, so two saves of an unchanged root list the same entries in the same order.
    for current, dirs, files in os.walk(base):
        rel_dir = os.path.relpath(current, base)
        rel_dir = '' if rel_dir == '.' else rel_dir
        dirs[:] = sorted(d for d in dirs if not excluded(os.path.join(rel_dir, d), skip))
        for name in dirs:
            yield os.path.join(rel_dir, name)
        for name in sorted(files):
            rel = os.path.join(rel_dir, name)
            if not excluded(rel, skip):
                yield rel


def list_trees(root):
    main = root / 'workspace'
    if not (main / '.git').is_dir():
        return []
    trees, entry = [], {}
    for line in out(main, 'worktree', 'list', '--porcelain').splitlines() + ['']:
        if line:
            key, _, value = line.partition(' ')
            entry[key] = value
            continue
        if entry.get('worktree'):
            path = pathlib.Path(entry['worktree'])
            if 'prunable' not in entry and path.is_dir():
                if path == main:
                    trees.insert(0, path)
                elif root in path.parents:
                    trees.append(path)
        entry = {}
    return trees

def index_copy(tree, directory):
    copy = pathlib.Path(directory) / ('index-' + uuid.uuid4().hex)
    source = tree / out(tree, 'rev-parse', '--git-path', 'index')
    if source.is_file():
        shutil.copyfile(source, copy)
    return copy

def tree_head(tree):
    commit = git(tree, 'rev-parse', '-q', '--verify', 'HEAD^{commit}', check=False).stdout.decode().strip() or None
    branch = git(tree, 'symbolic-ref', '-q', 'HEAD', check=False).stdout.decode().strip() or None
    if branch and commit:
        return {'kind': 'branch', 'ref': branch, 'commit': commit}
    if branch:
        return {'kind': 'unborn', 'ref': branch}
    return {'kind': 'detached', 'commit': commit}

def ignored_files(tree):
    listing = git(tree, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z').stdout.decode()
    files = []
    for rel in sorted(filter(None, listing.split('\0'))):
        path = tree / rel
        if rel.endswith('/') or path.is_dir():
            continue
        if path.is_symlink() or (path.is_file() and path.stat().st_size <= IGNORED_FILE_MAX):
            files.append(rel)
    return files

def capture_tree(tree, scratch):
    # Two commits per tree, built from copies of the index so a running agent's
    # index is never written: what was staged, and the whole working tree
    # including untracked files. Restoring both reproduces staged, unstaged,
    # untracked and deleted state exactly.
    head = tree_head(tree)
    parents = ['-p', head['commit']] if head.get('commit') else []
    staged = index_copy(tree, scratch)
    working = index_copy(tree, scratch)
    try:
        index_tree = git(tree, 'write-tree', env=git_env({'GIT_INDEX_FILE': str(staged)}), check=False)
        git(tree, 'add', '-A', env=git_env({'GIT_INDEX_FILE': str(working)}))
        work_tree = out(tree, 'write-tree', env=git_env({'GIT_INDEX_FILE': str(working)}))
    finally:
        staged.unlink(missing_ok=True)
        working.unlink(missing_ok=True)
    # An index with unresolved conflicts cannot be written as a tree; its files,
    # conflict markers included, still survive in the working-tree commit.
    index = index_tree.stdout.decode().strip() if index_tree.returncode == 0 else work_tree
    dated = git_env(FIXED_DATES)
    index_commit = out(tree, 'commit-tree', index, *parents, '-m', 't3 snapshot index', env=dated)
    work_commit = out(tree, 'commit-tree', work_tree, *parents, '-p', index_commit, '-m', 't3 snapshot worktree', env=dated)
    return head, index_commit, work_commit

def fingerprint(root, trees, skip_home):
    digest = hashlib.sha256()
    def add(*values):
        digest.update(json.dumps(values).encode() + b'\n')
    def stat(path, rel):
        with contextlib.suppress(OSError):
            info = os.lstat(path)
            add(rel, info.st_size, info.st_mtime_ns, info.st_mode)
    if trees:
        main = trees[0]
        add(out(main, 'for-each-ref', '--format=%(refname) %(objectname)'))
        add(git(main, 'reflog', 'show', '--format=%H %gs', 'refs/stash', check=False).stdout.decode())
    for tree in trees:
        staged = index_copy(tree, tempfile.gettempdir())
        try:
            add(str(tree), tree_head(tree), git(tree, 'write-tree', env=git_env({'GIT_INDEX_FILE': str(staged)}), check=False).stdout.decode())
        finally:
            staged.unlink(missing_ok=True)
        changed = git(tree, 'diff-files', '--name-only', '-z').stdout.decode().split('\0')
        untracked = git(tree, 'ls-files', '--others', '--exclude-standard', '-z').stdout.decode().split('\0')
        for rel in sorted(set(filter(None, changed + untracked)) | set(ignored_files(tree))):
            stat(tree / rel, rel)
    for name in ROOT_FILES:
        stat(root / name, name)
    home = root / 'home'
    if home.is_dir():
        for rel in walk(home, skip_home):
            # Readers rewrite a WAL database's shared-memory index; it holds no data.
            if not (rel.endswith('-shm') and is_sqlite(str(home / rel[:-4]))):
                stat(home / rel, rel)
    return digest.hexdigest()


class Sink:
    def __init__(self, handle, limit):
        self.handle, self.limit, self.size, self.digest = handle, limit, 0, hashlib.sha256()
    def write(self, data):
        self.size += len(data)
        if self.size > self.limit:
            raise RuntimeError('The chat snapshot exceeds ' + str(self.limit) + ' bytes; a cache is probably being saved')
        self.digest.update(data)
        self.handle.write(data)
        return len(data)

def tar_info(name, info):
    entry = tarfile.TarInfo(name)
    entry.mode = info.st_mode & 0o7777
    entry.mtime = info.st_mtime
    return entry

def is_sqlite(path):
    try:
        with open(path, 'rb') as data:
            return data.read(16) == SQLITE_MAGIC
    except OSError:
        return False

def add_path(archive, name, path, live, scratch):
    info = os.lstat(path)
    if os.path.islink(path):
        entry = tar_info(name, info)
        entry.type = tarfile.SYMTYPE
        entry.linkname = os.readlink(path)
        archive.addfile(entry)
    elif os.path.isdir(path):
        entry = tar_info(name, info)
        entry.type = tarfile.DIRTYPE
        archive.addfile(entry)
    elif os.path.isfile(path):
        # Spooled first, so a file that grows or shrinks during a live save
        # cannot corrupt the archive.
        with tempfile.TemporaryFile(dir=scratch) as spool:
            if live and is_sqlite(path):
                # A live database is copied through SQLite, which reads past an
                # uncheckpointed WAL; its -wal and -shm files are left out.
                copy = pathlib.Path(scratch) / ('db-' + uuid.uuid4().hex)
                try:
                    source = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
                    target = sqlite3.connect(str(copy))
                    with target:
                        source.backup(target)
                    source.close()
                    target.close()
                    with open(copy, 'rb') as data:
                        shutil.copyfileobj(data, spool)
                finally:
                    copy.unlink(missing_ok=True)
            else:
                with open(path, 'rb') as data:
                    shutil.copyfileobj(data, spool)
            entry = tar_info(name, info)
            entry.size = spool.tell()
            spool.seek(0)
            archive.addfile(entry, spool)

def sqlite_sidecar(path):
    for suffix in ('-wal', '-shm', '-journal'):
        if path.endswith(suffix) and is_sqlite(path[:-len(suffix)]):
            return True
    return False

def add_bytes(archive, name, data):
    entry = tarfile.TarInfo(name)
    entry.size = len(data)
    entry.mode = 0o600
    archive.addfile(entry, io.BytesIO(data))

def bound_history(repo):
    # A bundle carries commits but not where a shallow clone cut their history short, so a
    # restored commit can name a parent no Mac ever fetched. Marked shallow, git stops there
    # instead of failing on it, as in the clone the commit came from.
    listing = out(repo, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)')
    commits = [line.split()[0] for line in listing.splitlines() if line.endswith(' commit')]
    if not commits:
        return
    present = set(commits)
    data = git(repo, 'cat-file', '--batch', data=('\n'.join(commits) + '\n').encode()).stdout
    cut, position = [], 0
    while position < len(data):
        header_end = data.index(b'\n', position)
        name, _, size = data[position:header_end].decode().split(' ')
        body = data[header_end + 1:header_end + 1 + int(size)]
        position = header_end + 1 + int(size) + 1
        parents = [line[7:].decode() for line in body.split(b'\n\n', 1)[0].split(b'\n') if line.startswith(b'parent ')]
        if any(parent not in present for parent in parents):
            cut.append(name)
    shallow = repo / '.git' / 'shallow'
    known = set(shallow.read_text().split()) if shallow.exists() else set()
    if not set(cut) <= known:
        atomic(shallow, ''.join(commit + '\n' for commit in sorted(known | set(cut))))

def bundle_prerequisites(bundle):
    prerequisites = []
    with open(bundle, 'rb') as data:
        if not data.readline().startswith(b'# v2 git bundle'):
            raise RuntimeError('Unexpected git bundle format')
        for line in iter(data.readline, b'\n'):
            if line.startswith(b'-'):
                prerequisites.append(line[1:41].decode())
    return prerequisites

def save(spec):
    root = pathlib.Path(spec['root'])
    live = spec['mode'] == 'live'
    if not (root / 'preparation.json').is_file():
        raise RuntimeError('No prepared chat lives at this root')
    with locked(root / 'prepare.lock'):
        if not (root / 'preparation.json').is_file():
            raise RuntimeError('No prepared chat lives at this root')
        if not live:
            stop_server(root)
        skip_home = DERIVED_HOME + list(spec.get('derivedHomePaths') or []) + GIT_SAVED_HOME
        trees = list_trees(root)
        print_fingerprint = fingerprint(root, trees, skip_home)
        if spec.get('previousFingerprint') == print_fingerprint:
            return {'kind': 'unchanged', 'fingerprint': print_fingerprint}
        scratch = tempfile.mkdtemp(prefix='t3-save-', dir=spec.get('scratch'))
        try:
            archive_path = pathlib.Path(scratch) / 'snapshot.tar'
            with open(archive_path, 'wb') as handle:
                sink = Sink(handle, spec['maxBytes'])
                with tarfile.open(fileobj=sink, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                    manifest = {'format': FORMAT, 'root': str(root), 'mode': spec['mode'], 'fingerprint': print_fingerprint, 'trees': [], 'stash': [], 'refs': {}, 'remoteRefs': {}, 'prerequisites': []}
                    main = trees[0] if trees else None
                    bundle = pathlib.Path(scratch) / 'repo.bundle'
                    if main is not None:
                        try:
                            for index, tree in enumerate(trees):
                                head, index_commit, work_commit = capture_tree(tree, scratch)
                                git(main, 'update-ref', SNAPSHOT_REFS + str(index) + '/index', index_commit)
                                git(main, 'update-ref', SNAPSHOT_REFS + str(index) + '/worktree', work_commit)
                                manifest['trees'].append({'path': str(tree.relative_to(root)), 'head': head, 'index': index_commit, 'worktree': work_commit, 'ignored': ignored_files(tree)})
                            stash = git(main, 'reflog', 'show', '--format=%H%x00%gs', 'refs/stash', check=False).stdout.decode()
                            for index, line in enumerate(filter(None, stash.splitlines())):
                                commit, _, message = line.partition('\0')
                                git(main, 'update-ref', SNAPSHOT_REFS + 'stash/' + str(index), commit)
                                manifest['stash'].append({'commit': commit, 'message': message})
                            refs = []
                            for line in out(main, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)').splitlines():
                                name, commit, symref = line.split('\0')
                                if name.startswith('refs/remotes/'):
                                    if not symref:
                                        manifest['remoteRefs'][name] = commit
                                elif name != 'refs/stash':
                                    refs.append(name)
                                    # A bundle leaves out a ref whose commit origin has, so every ref is named here.
                                    if not name.startswith(SNAPSHOT_REFS):
                                        manifest['refs'][name] = commit
                            has_origin = git(main, 'remote', 'get-url', 'origin', check=False).returncode == 0
                            bound_history(main)
                            git(main, 'bundle', 'create', str(bundle), '--stdin', *(['--not', '--remotes=origin'] if has_origin else []), data=('\n'.join(refs) + '\n').encode())
                            manifest['prerequisites'] = bundle_prerequisites(bundle)
                        finally:
                            for name in out(main, 'for-each-ref', '--format=%(refname)', SNAPSHOT_REFS).splitlines():
                                git(main, 'update-ref', '-d', name, check=False)
                    add_bytes(archive, 'manifest.json', json.dumps(manifest, sort_keys=True).encode())
                    if main is not None:
                        add_path(archive, 'repo.bundle', bundle, False, scratch)
                        gitdir = main / '.git'
                        for name in ('config', 'info/exclude'):
                            if (gitdir / name).is_file():
                                add_path(archive, 'git/' + name, gitdir / name, False, scratch)
                        for index, tree in enumerate(trees):
                            for rel in manifest['trees'][index]['ignored']:
                                add_path(archive, 'trees/' + str(index) + '/' + rel, tree / rel, False, scratch)
                    journal = json.loads((root / 'preparation.json').read_text())
                    for key in WARM_KEYS:
                        journal.pop(key, None)
                    add_bytes(archive, 'root/preparation.json', json.dumps(journal).encode())
                    if (root / 'broker-token').is_file():
                        add_path(archive, 'root/broker-token', root / 'broker-token', False, scratch)
                    home = root / 'home'
                    if home.is_dir():
                        for rel in walk(home, skip_home):
                            path = str(home / rel)
                            if live and sqlite_sidecar(path):
                                continue
                            if os.path.islink(path) or os.path.isdir(path) or os.path.isfile(path):
                                add_path(archive, 'home/' + rel, path, live, scratch)
            sha256, size = sink.digest.hexdigest(), sink.size
            upload(spec['uploadUrl'], archive_path, size)
            return {'kind': 'saved', 'sha256': sha256, 'bytes': size, 'fingerprint': print_fingerprint}
        finally:
            rmtree(scratch, ignore=True)

def upload(url, path, size):
    failure = None
    for attempt in range(3):
        try:
            with open(path, 'rb') as data:
                request = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Length': str(size), 'Content-Type': 'application/octet-stream'})
                with urllib.request.urlopen(request, timeout=900) as response:
                    response.read()
            return
        except OSError as error:
            failure = error
            time.sleep(2 ** attempt)
    raise RuntimeError('Snapshot upload failed: ' + str(failure))

def download(url, target, expected):
    digest = hashlib.sha256()
    try:
        with urllib.request.urlopen(url, timeout=900) as response, open(target, 'wb') as output:
            for chunk in iter(lambda: response.read(1024 * 1024), b''):
                digest.update(chunk)
                output.write(chunk)
    except OSError as error:
        raise RuntimeError('Snapshot download failed: ' + str(error))
    if digest.hexdigest() != expected:
        raise RuntimeError('Snapshot digest mismatch')


def extract(archive, member, target):
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        target.unlink()
    if member.isdir():
        target.mkdir(parents=True, exist_ok=True)
        target.chmod(member.mode)
    elif member.issym():
        target.parent.mkdir(parents=True, exist_ok=True)
        os.symlink(member.linkname, target)
    elif member.isfile():
        target.parent.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, open(target, 'wb') as output:
            shutil.copyfileobj(source, output)
        target.chmod(member.mode)
        os.utime(target, (member.mtime, member.mtime))

def restore_tree(tree, entry, archive, index):
    head = entry['head']
    if head['kind'] == 'detached':
        git(tree, 'update-ref', '--no-deref', 'HEAD', head['commit'])
    else:
        git(tree, 'symbolic-ref', 'HEAD', head['ref'])
    git(tree, 'read-tree', '-u', '--reset', entry['worktree'] + '^{tree}')
    git(tree, 'clean', '-fdq')
    git(tree, 'read-tree', entry['index'] + '^{tree}')
    for rel in entry['ignored']:
        extract(archive, archive.getmember('trees/' + str(index) + '/' + rel), contained(tree, rel))
    git(tree, 'update-index', '-q', '--refresh', check=False)

def restore_repository(root, manifest, archive, scratch, token):
    trees = manifest['trees']
    main, partial = root / 'workspace', root / 'workspace.partial'
    repo = main if main.exists() else partial
    if not (repo / '.git').is_dir():
        if repo.exists():
            rmtree(repo)
        repo.mkdir(mode=0o700)
        git(repo, 'init', '-q')
    gitdir = repo / '.git'
    for name in ('config', 'info/exclude'):
        with contextlib.suppress(KeyError):
            extract(archive, archive.getmember('git/' + name), gitdir / name)
    fetch_env = git_env()
    if token:
        fetch_env.update({'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader', 'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode()})
    def fetch_missing(commits):
        missing = sorted(commit for commit in set(commits) if git(repo, 'cat-file', '-e', commit + '^{commit}', check=False).returncode != 0)
        if missing:
            # Nothing but this locked restore touches the checkout, so a shallow.lock was stranded.
            (gitdir / 'shallow.lock').unlink(missing_ok=True)
            git(repo, '-c', 'protocol.version=2', 'fetch', '--depth=1', '--no-tags', 'origin', *missing, env=fetch_env)
    fetch_missing(manifest['prerequisites'])
    bundle = pathlib.Path(scratch) / 'repo.bundle'
    extract(archive, archive.getmember('repo.bundle'), bundle)
    out(repo, 'bundle', 'unbundle', str(bundle))
    desired = dict(manifest['refs'])
    desired.update(manifest['remoteRefs'])
    fetch_missing(desired.values())
    bound_history(repo)
    for name in out(repo, 'for-each-ref', '--format=%(refname)').splitlines():
        if name not in desired and not name.startswith(SNAPSHOT_REFS):
            git(repo, 'update-ref', '-d', name)
    commands = ''.join('update ' + name + ' ' + commit + '\n' for name, commit in desired.items() if name != 'refs/stash')
    git(repo, 'update-ref', '--stdin', data=commands.encode())
    restore_tree(repo, trees[0], archive, 0)
    git(repo, 'update-ref', '-d', 'refs/stash', check=False)
    for entry in reversed(manifest['stash']):
        git(repo, 'stash', 'store', '-m', entry['message'], entry['commit'])
    if repo == partial:
        os.rename(partial, main)
        fsync_dir(root)
    git(main, 'worktree', 'prune')
    for index, entry in enumerate(trees[1:], start=1):
        path = contained(root, entry['path'])
        if path.exists():
            rmtree(path)
            git(main, 'worktree', 'prune')
        git(main, 'worktree', 'add', '--force', '--no-checkout', '--detach', str(path), entry['worktree'])
        restore_tree(path, entry, archive, index)

def restore(spec):
    root = pathlib.Path(spec['root'])
    expected = spec['snapshot']['sha256']
    with locked(root / 'prepare.lock'):
        receipt_path = root / 'restore.json'
        receipt = read_json(receipt_path)
        if receipt is not None and receipt.get('sha256') != expected:
            raise RuntimeError('This root holds a different restore')
        if receipt is not None and receipt.get('done'):
            return {'restored': expected}
        if receipt is None and (root / 'preparation.json').exists():
            raise RuntimeError('A chat already lives at this root')
        atomic(receipt_path, json.dumps({'sha256': expected, 'done': False}))
        scratch = tempfile.mkdtemp(prefix='t3-restore-', dir=spec.get('scratch'))
        try:
            archive_path = pathlib.Path(scratch) / 'snapshot.tar'
            download(spec['snapshot']['url'], archive_path, expected)
            with tarfile.open(archive_path) as archive:
                manifest = json.loads(archive.extractfile('manifest.json').read())
                if manifest.get('format') != FORMAT or manifest.get('root') != str(root):
                    raise RuntimeError('Snapshot was taken at another root or format')
                if manifest['trees']:
                    restore_repository(root, manifest, archive, scratch, spec.get('accessToken'))
                home = root / 'home'
                home.mkdir(mode=0o700, exist_ok=True)
                for member in archive.getmembers():
                    if member.name.startswith('home/'):
                        extract(archive, member, contained(home, member.name[len('home/'):]))
                with contextlib.suppress(KeyError):
                    extract(archive, archive.getmember('root/broker-token'), root / 'broker-token')
                journal = json.loads(archive.extractfile('root/preparation.json').read())
            # The runtime record always describes the disk it sits on: the
            # template's, when this root was adopted from one.
            warm = read_json(root / 'warm.json') or {}
            journal.update({key: warm[key] for key in WARM_KEYS if key in warm})
            atomic(root / 'preparation.json', json.dumps(journal))
            (root / 'warm.json').unlink(missing_ok=True)
            atomic(receipt_path, json.dumps({'sha256': expected, 'done': True}))
            return {'restored': expected}
        finally:
            rmtree(scratch, ignore=True)


def probe(spec, marker, template, root):
    if not isinstance(marker, dict) or marker.get('format') != FORMAT or marker.get('root') != str(root) or marker.get('repository') != spec['repository']:
        return 'miss'
    if not (template / 'warm.json').is_file() or (template / 'preparation.json').exists():
        return 'miss'
    if marker.get('key') != spec['key'] or marker.get('runtimeSha256') != spec['runtimeSha256']:
        return 'stale'
    if time.time() - marker.get('sealedAt', 0) > spec['maxAgeSeconds']:
        return 'stale'
    return 'hit'

def adopt(spec):
    mount, root = pathlib.Path(spec['mount']), pathlib.Path(spec['root'])
    if root.parent != mount:
        raise RuntimeError('The chat root must sit directly on the cache volume')
    template = mount / 'template'
    instance = spec['instanceId']
    with locked(mount / 'cache.lock'):
        # A receipt counts only on the Mac that wrote it. A root or template that
        # arrived with the volume is another machine's, left by a commit that
        # should have been an abandon.
        receipt = read_json(root / 'adopt.json')
        if isinstance(receipt, dict) and receipt.get('instanceId') == instance:
            return receipt
        staged = read_json(template / 'adopt.json')
        if isinstance(staged, dict) and staged.get('instanceId') == instance and not root.exists():
            os.rename(template, root)
            fsync_dir(mount)
            return staged
        if root.exists():
            purge_chat(root)
            trash(mount, root)
        marker = read_json(mount / 'template.json')
        cache = 'miss' if staged is not None else probe(spec, marker, template, root)
        result = {'cache': cache, 'instanceId': instance, 'nonce': uuid.uuid4().hex}
        if cache == 'miss':
            if template.exists():
                trash(mount, template)
            root.mkdir(mode=0o700)
            atomic(root / 'adopt.json', json.dumps(result))
            return result
        # The marker goes first: from here this tree is one chat's, and a volume
        # committed without a fresh seal carries no marker to adopt.
        (mount / 'template.json').unlink()
        fsync_dir(mount)
        if marker['runtimeSha256'] != spec['runtimeSha256']:
            # Preparation would otherwise trust the template's runtime record and run that build.
            for name in ('artifact', 'runtime', 'warm.json'):
                remove(template / name)
        atomic(template / 'adopt.json', json.dumps(result))
        os.rename(template, root)
        fsync_dir(mount)
        return result

def purge_chat(root):
    # A root that arrived with the volume is another chat's, left by a destroy that committed.
    # Its credentials, journal and transcripts go before anything runs here; the rest, mostly
    # derived trees, is deleted in the background.
    for name in ('broker-token', 'preparation.json', 'restore.json', 'adopt.json'):
        remove(root / name)
    if (root / 'home').is_dir() and not (root / 'home').is_symlink():
        keep_only(root / 'home', DERIVED_HOME)
    for name in ('workspace', 'workspace.partial'):
        tree = root / name
        if not tree.is_dir() or tree.is_symlink():
            continue
        for current, dirs, files in os.walk(tree):
            # Dependency and git trees hold no dotenv files of the chat's own, and are vast.
            dirs[:] = [d for d in dirs if d not in ('node_modules', '.git')]
            for file in files:
                if file.startswith('.env'):
                    remove(pathlib.Path(current) / file)

def keep_only(base, keep):
    for entry in sorted(os.listdir(base)):
        path = base / entry
        if entry in keep:
            continue
        nested = [k[len(entry) + 1:] for k in keep if k.startswith(entry + '/')]
        if nested and path.is_dir() and not path.is_symlink():
            keep_only(path, nested)
        else:
            remove(path)

def clone(source, target):
    if sys.platform == 'darwin':
        # APFS clones the tree without copying its blocks.
        if subprocess.run(['cp', '-cRp', str(source), str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return
        if target.exists():
            rmtree(target)
        command = ['cp', '-Rp', str(source), str(target)]
    else:
        command = ['cp', '-a', '--reflink=auto', str(source), str(target)]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError('Copying the root failed: ' + result.stderr.decode(errors='replace')[-500:])

def scrub_template(template, spec):
    journal = json.loads((template / 'preparation.json').read_text())
    atomic(template / 'warm.json', json.dumps({key: journal[key] for key in WARM_KEYS if key in journal}))
    (template / 'preparation.json').unlink()
    for entry in os.listdir(template):
        if entry in ('broker-token', 'server.json', 'server.log', 'server.lock', 'prepare.lock', 'tool-install.log', 'adopt.json', 'restore.json') or entry.startswith(('input-', 'artifact-')):
            remove(template / entry)
    home = template / 'home'
    if home.is_dir():
        keep_only(home, DERIVED_HOME + list(spec.get('derivedHomePaths') or []))
    workspace = template / 'workspace'
    for file in spec.get('files') or []:
        if file['scope'] == 'workspace':
            with contextlib.suppress(FileNotFoundError):
                remove(contained(workspace, file['destination']))
    head = git(workspace, 'rev-parse', '-q', '--verify', 'HEAD^{commit}', check=False).stdout.decode().strip()
    for name in out(workspace, 'for-each-ref', '--format=%(refname)').splitlines():
        if not name.startswith('refs/remotes/origin/'):
            git(workspace, 'update-ref', '-d', name)
    if head:
        git(workspace, 'update-ref', '--no-deref', 'HEAD', head)
    git(workspace, 'worktree', 'prune')
    git(workspace, 'reflog', 'expire', '--expire=now', '--all')
    for name in ('FETCH_HEAD', 'ORIG_HEAD'):
        (workspace / '.git' / name).unlink(missing_ok=True)
    git(workspace, 'clean', '-fdq')
    os.rename(workspace, template / 'workspace.partial')

def template_digest(mount):
    # Metadata, not content: a sealed template is many gigabytes. ctime and the inode number
    # change on any write, chmod, utime or replacement, and userland cannot set them back.
    digest = hashlib.sha256()
    template = mount / 'template'
    def add(path, rel):
        info = os.lstat(path)
        link = os.readlink(path) if stat.S_ISLNK(info.st_mode) else None
        digest.update(json.dumps([rel, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_ino, link]).encode() + b'\n')
    add(template, '.')
    for current, dirs, files in os.walk(template):
        dirs.sort()
        for name in sorted(dirs + files):
            path = os.path.join(current, name)
            add(path, os.path.relpath(path, template))
    digest.update((mount / 'template.json').read_bytes())
    return digest.hexdigest()

# What a committed volume may hold: the template, its marker, and runtime archives a chat only
# uses after checking their digest. The last two are macOS's own and only root writes them;
# its trash folders are not kept, since any user can put files there.
VOLUME_ENTRIES = re.compile(r'(template|template\.json|cache\.lock|t3-runtime-[0-9a-f]{64}\.tar|\.Spotlight-V100|\.fseventsd)')

def seal(spec):
    mount, root = pathlib.Path(spec['mount']), pathlib.Path(spec['root'])
    with locked(root / 'prepare.lock'), locked(mount / 'cache.lock'):
        adopted = read_json(root / 'adopt.json')
        if adopted is None:
            raise RuntimeError('Only an adopted root can seal a template')
        marker_path = mount / 'template.json'
        marker = read_json(marker_path)
        if isinstance(marker, dict) and marker.get('sealedFrom') == adopted['nonce']:
            return {'sealed': True, 'digest': template_digest(mount)}
        if not (root / 'preparation.json').is_file() or not (root / 'workspace' / '.git').is_dir():
            raise RuntimeError('Only a prepared root can seal a template')
        # Spotlight would rewrite the template's metadata and fail its check at commit.
        subprocess.run(['sudo', '-n', 'mdutil', '-i', 'off', str(mount)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        partial = mount / 'template.partial'
        if partial.exists():
            rmtree(partial)
        clone(root, partial)
        scrub_template(partial, spec)
        marker_path.unlink(missing_ok=True)
        fsync_dir(mount)
        if (mount / 'template').exists():
            trash(mount, mount / 'template')
        os.rename(partial, mount / 'template')
        fsync_dir(mount)
        atomic(marker_path, json.dumps({'format': FORMAT, 'root': str(root), 'repository': spec['repository'], 'key': spec['key'], 'runtimeSha256': spec['runtimeSha256'], 'sealedAt': time.time(), 'sealedFrom': adopted['nonce']}))
        return {'sealed': True, 'digest': template_digest(mount)}

def scrub(spec):
    mount, root = pathlib.Path(spec['mount']), pathlib.Path(spec['root'])
    with locked(mount / 'cache.lock'):
        if root.exists():
            trash(mount, root, wait=True)
        for entry in os.listdir(mount):
            if not VOLUME_ENTRIES.fullmatch(entry):
                try:
                    remove(mount / entry)
                except OSError:
                    # macOS makes its trash folders root-owned; Namespace Macs have passwordless sudo.
                    for command in (['chflags', '-R', 'nouchg'], ['rm', '-rf']):
                        subprocess.run(['sudo', '-n', *command, str(mount / entry)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        left = sorted(entry for entry in os.listdir(mount) if not VOLUME_ENTRIES.fullmatch(entry))
        if left:
            raise RuntimeError('The volume still holds ' + ', '.join(left))
        expected = spec.get('templateDigest')
        # The chat ran with the volume writable: anything it planted in the template would run
        # in every later chat that adopts it.
        if expected is not None:
            try:
                unchanged = template_digest(mount) == expected
            except OSError:
                unchanged = False
            if not unchanged:
                raise RuntimeError('The template changed after it was sealed')
    return {'scrubbed': True}

VERBS = {'adopt': adopt, 'restore': restore, 'save': save, 'seal': seal, 'scrub': scrub}

try:
    request = json.load(sys.stdin)
    print(json.dumps(VERBS[request['verb']](request)))
except Exception as error:
    sys.stderr.write('Guest chat state failed: ' + str(error) + '\n')
    sys.exit(1)
`;

async function runVerb<A>(
  port: RemotePreparationPort,
  verb: string,
  input: object,
  decode: (stdout: string) => A,
): Promise<A> {
  const result = await port.executePython({
    script: guestChatStateScript,
    stdin: JSON.stringify({ ...input, verb }),
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(detail && detail.length > 0 ? detail : `Guest chat state ${verb} failed.`);
  }
  return decode(result.stdout);
}

/** What the guest found on the cache volume. Only a new chat that adopted no current template fills one. */
export const CacheProbe = Schema.Literals(["hit", "stale", "miss"]);
export type CacheProbe = typeof CacheProbe.Type;

const decodeAdopted = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ cache: CacheProbe })),
);
const decodeRestored = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ restored: Schema.String })),
);
const decodeSealed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ sealed: Schema.Literal(true), digest: Schema.String })),
);
const decodeScrubbed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ scrubbed: Schema.Literal(true) })),
);
const SaveResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("saved"),
    sha256: Schema.String,
    bytes: Schema.Finite,
    fingerprint: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("unchanged"), fingerprint: Schema.String }),
]);
export type SaveResult = typeof SaveResult.Type;
const decodeSaved = Schema.decodeUnknownSync(Schema.fromJsonString(SaveResult));

interface TemplateIdentity {
  readonly mount: string;
  readonly root: string;
  readonly repository: string | null;
  /** Changes when what preparation builds changes, so an older template reads as stale. */
  readonly key: string;
  readonly runtimeSha256: string;
}

/**
 * First guest step on every new Mac: moves the volume's sealed template into
 * place as the chat root, or clears the root on a miss. A stale template is
 * still adopted, minus its runtime when that differs.
 */
export function adoptChatTemplate(
  port: RemotePreparationPort,
  input: TemplateIdentity & {
    /** Binds the receipt to this Mac: a root or template that arrived with the volume is another's. */
    readonly instanceId: string;
    readonly maxAgeSeconds: number;
  },
) {
  return runVerb(port, "adopt", input, decodeAdopted).then(({ cache }) => cache);
}

/** Lays a snapshot onto an adopted root before preparation runs. */
export async function restoreChat(
  port: RemotePreparationPort,
  input: {
    readonly root: string;
    readonly snapshot: { readonly url: string; readonly sha256: string };
    readonly accessToken?: string | undefined;
    readonly scratch?: string | undefined;
  },
) {
  await runVerb(port, "restore", input, decodeRestored);
}

/**
 * Snapshots the chat and PUTs it to a signed URL. `final` stops the T3 server
 * (and the agents it runs) first so the snapshot is exact; `live` copies under
 * a running server. Returns `unchanged` without uploading when the root still
 * matches `previousFingerprint`. Refuses a root with no preparation journal,
 * so a scrubbed or sealed root can never be saved over a chat.
 */
export function saveChat(
  port: RemotePreparationPort,
  input: {
    readonly root: string;
    readonly mode: "final" | "live";
    readonly uploadUrl: string;
    readonly maxBytes: number;
    readonly previousFingerprint: string | null;
    readonly derivedHomePaths?: ReadonlyArray<string>;
    readonly scratch?: string | undefined;
  },
) {
  return runVerb(port, "save", input, decodeSaved);
}

/**
 * Copies a freshly prepared, never-used root into the volume's template and
 * writes the marker last. Run by a chat that filled a miss, before its first
 * turn. Returns the template's digest, which the manager keeps and `scrubChatRoot`
 * checks before the volume may be committed.
 */
export async function sealChatTemplate(
  port: RemotePreparationPort,
  input: TemplateIdentity & {
    readonly files: ReadonlyArray<{
      readonly scope: "home" | "workspace";
      readonly destination: string;
    }>;
    readonly derivedHomePaths?: ReadonlyArray<string>;
  },
) {
  return (await runVerb(port, "seal", input, decodeSealed)).digest;
}

/**
 * Removes the chat root and anything else but the template from the volume, so committing it
 * leaves only the template. With `templateDigest`, refuses a template that changed since it was
 * sealed, since its chat ran with the volume writable.
 */
export async function scrubChatRoot(
  port: RemotePreparationPort,
  input: {
    readonly mount: string;
    readonly root: string;
    readonly templateDigest?: string | undefined;
  },
) {
  await runVerb(port, "scrub", input, decodeScrubbed);
}
