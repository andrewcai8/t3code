import { AuthAccessWriteScope, ProvisionReadiness } from "@t3tools/contracts";
import { Schema } from "effect";
import type { RecordProvisionPhase } from "./provisionTiming.ts";

/** Trusted host-local inputs. Package dependencies are installed on the target host when requested. */
export interface RemotePreparationInput {
  readonly requestId: string;
  readonly resourceIdentity: string;
  readonly requestHash: string;
  readonly preparationHash: string;
  readonly root: string;
  readonly repository: {
    readonly url: string;
    readonly revision: string;
    readonly accessToken?: string | undefined;
  } | null;
  readonly artifact: {
    readonly archivePath: string;
    readonly sha256: string;
    readonly revision: string;
    readonly entrypoint: string;
    readonly install?: "npm" | undefined;
  };
  readonly runtimeExecutable: string;
  readonly port: number;
  readonly readinessTimeoutSeconds: number;
  readonly brokerTtl: string;
  readonly files: ReadonlyArray<{
    readonly scope: "home" | "workspace";
    readonly destination: string;
    readonly sha256: string;
    readonly contentsBase64: string;
  }>;
  /** Closed-set shell command from guestProviderInstallCommand. Runs in the isolated home. */
  readonly providerInstall?: string | undefined;
  /**
   * Operator-configured setup for this repository, run in the checkout once it
   * exists. A cloud box arrives with the repository but none of its toolchain
   * otherwise, so the first thing every agent does is install one.
   */
  readonly prepareCommands?: ReadonlyArray<string> | undefined;
  /** Artifacts fetched by the guest into the isolated home before setup runs. */
  readonly artifacts?:
    | ReadonlyArray<{
        readonly path: string;
        readonly destination: string;
        readonly sha256: string;
      }>
    | undefined;
  /**
   * Where each artifact is fetched from, by `path`. Kept apart from the frozen
   * descriptors because a signed URL expires in minutes while a manifest is
   * replayed for as long as its environment lives, so a URL is resolved per
   * attempt and never becomes part of the preparation's identity.
   */
  readonly artifactSources?:
    | ReadonlyArray<{ readonly path: string; readonly url: string }>
    | undefined;
  /**
   * The build the guest converges to when it differs from `artifact`, which
   * stays the environment's identity. Excluded from the guest's intent hash
   * like `artifactSources`, so an environment prepared before this field
   * existed still recognises its journal.
   */
  readonly runtime?: RemotePreparationInput["artifact"] | undefined;
  /**
   * The branch whose tip every open fetches into `refs/remotes/origin/<branch>`,
   * or `HEAD` for the remote's default branch. HEAD itself never moves after
   * the first prepare. Excluded from the intent hash like `runtime`.
   */
  readonly follow?: string | undefined;
}

export const RemotePreparationReady = Schema.Struct({
  ...ProvisionReadiness.fields,
  headRevision: ProvisionReadiness.fields.t3Revision,
  /** Why this open could not fetch the followed branch. */
  refreshError: Schema.optional(Schema.NullOr(Schema.String)),
  artifactSha256: ProvisionReadiness.fields.preparationHash,
  runtimeVersion: Schema.String,
  serverPid: Schema.Int,
  brokerCredentialPath: Schema.String,
});
export type RemotePreparationReady = typeof RemotePreparationReady.Type;
const decodeReady = Schema.decodeUnknownSync(Schema.fromJsonString(RemotePreparationReady));
// Decoded apart from RemotePreparationReady because that type flows into the
// persisted ProvisionReadiness state. RemotePreparationInput stays unchanged for
// a similar reason: the Python hashes the whole spec into `intent` and compares
// it against a journal on the guest, so adding an input field would invalidate
// every in-flight preparation root.
const decodePhases = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      phases: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            phase: Schema.String,
            durationMs: Schema.Number,
            bytes: Schema.optionalKey(Schema.Number),
          }),
        ),
      ),
    }),
  ),
);

/** The transport must send stdin privately and must not log it or remote private files. */
export interface RemotePreparationPort {
  executePython(input: {
    readonly script: string;
    readonly stdin: string;
  }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr?: string }>;
}

export async function prepareRemoteHost(
  port: RemotePreparationPort,
  input: RemotePreparationInput,
  record?: RecordProvisionPhase,
): Promise<RemotePreparationReady> {
  const startedAt = performance.now();
  const result = await port.executePython({
    script: remotePreparationScript,
    stdin: JSON.stringify(input),
  });
  const roundTripMs = performance.now() - startedAt;
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(detail && detail.length > 0 ? detail : "Remote preparation failed.");
  }
  const ready = decodeReady(result.stdout);
  const phases = decodePhases(result.stdout).phases ?? [];
  for (const entry of phases)
    record?.({
      phase: `remote.${entry.phase}`,
      durationMs: entry.durationMs,
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
    });
  // What the guest never sees: staging the script, streaming stdin, and the
  // transport's own round trip. Reported so a slow channel cannot hide inside
  // an untimed remainder.
  const guestMs = phases.find((entry) => entry.phase === "prepareTotal")?.durationMs;
  if (guestMs !== undefined)
    record?.({ phase: "remote.transport", durationMs: Math.max(0, roundTripMs - guestMs) });
  return ready;
}

const decodeRefreshed = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ refreshError: Schema.NullOr(Schema.String) })),
);

/**
 * Fetches the followed branch into an already prepared box, and nothing else:
 * the step a resume runs so the thread can see what was pushed while it slept.
 * Takes the same input as preparation, whose intent it verifies.
 */
export async function refreshRemoteCheckout(
  port: RemotePreparationPort,
  input: RemotePreparationInput,
): Promise<{ readonly refreshError: string | null }> {
  const result = await port.executePython({
    script: remotePreparationScript,
    stdin: JSON.stringify({ ...input, refreshOnly: true }),
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(detail && detail.length > 0 ? detail : "Remote refresh failed.");
  }
  return decodeRefreshed(result.stdout);
}

/** Python's kernel locks work on Linux and macOS and release when a preparation process dies. */
export const remotePreparationScript = String.raw`
import base64, contextlib, fcntl, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, tempfile, time, urllib.request, uuid

INTERPRETER_START = time.monotonic()
STARTUP = []
# Children preparation started without waiting on; stopped if it fails first.
BACKGROUND = []
os.umask(0o077)

def atomic(path, value):
    temp = path.with_name(path.name + '.tmp')
    with open(temp, 'w') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp, path)
    directory = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as data:
        for chunk in iter(lambda: data.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()

def contained(root, relative):
    rel = pathlib.PurePosixPath(relative)
    if rel.is_absolute():
        raise RuntimeError('Path escapes its preparation directory')
    parts = [part for part in rel.parts if part not in ('.', '')]
    if not parts or any(part == '..' for part in parts):
        raise RuntimeError('Path escapes its preparation directory')
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise RuntimeError('Symlink destinations are not supported')
    resolved_root = root.resolve()
    resolved = target.resolve()
    if resolved == resolved_root or resolved_root not in resolved.parents:
        raise RuntimeError('Path escapes its preparation directory')
    return target

def contained_link(root, target, linkname):
    if not linkname or pathlib.PurePosixPath(linkname).is_absolute():
        raise RuntimeError('Symlink destinations are not supported')
    resolved_root = root.resolve()
    resolved = (target.parent / linkname).resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise RuntimeError('Symlink destinations are not supported')

def artifact_snapshot(root):
    files, links = {}, {}
    for path in root.rglob('*'):
        name = str(path.relative_to(root))
        if path.is_symlink():
            links[name] = os.readlink(path)
        elif path.is_file():
            files[name] = digest(path)
    return files, links

def prepare(spec):
    phases = []
    entered = time.monotonic()
    @contextlib.contextmanager
    def step(name):
        started = time.monotonic()
        try:
            yield
        finally:
            phases.append({'phase': name, 'durationMs': round((time.monotonic() - started) * 1000)})
    def mark(name, since):
        phases.append({'phase': name, 'durationMs': round((time.monotonic() - since) * 1000)})
    phases.extend(STARTUP)
    root = pathlib.Path(spec['root'])
    if not root.is_absolute() or root.is_symlink():
        raise RuntimeError('Preparation requires a private absolute root')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('Preparation root must be private to its owner')
    with open(root / 'prepare.lock', 'a') as lock:
        locking = time.monotonic()
        fcntl.flock(lock, fcntl.LOCK_EX)
        mark('lockWait', locking)
        def run(args, cwd, env, timeout=300):
            # A surviving Git or auth child retains the lock if its preparer dies.
            # Close stdin and disable terminal prompts so a private clone cannot
            # wait forever for credentials the sandbox will never type.
            child = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, pass_fds=(lock.fileno(),))
            try:
                stdout, stderr = child.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                # SIGTERM first: Git removes its lock files on it, and a
                # SIGKILLed fetch strands shallow.lock for every later fetch.
                child.terminate()
                try:
                    child.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.communicate()
                raise RuntimeError('Preparation command timed out: ' + ' '.join(str(part) for part in args[:8]))
            if child.returncode != 0:
                detail = (stderr or stdout or '').strip()
                raise RuntimeError('Preparation command failed' + ((': ' + detail[-1500:]) if detail else ''))
            return stdout.strip()

        # Start a command preparation needs only later, then finish() it there.
        def start(args, cwd, env):
            log = tempfile.TemporaryFile(mode='w+')
            child = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, text=True, pass_fds=(lock.fileno(),), start_new_session=True)
            BACKGROUND.append(child)
            return child, log, args

        def finish(started, timeout):
            child, log, args = started
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                raise RuntimeError('Preparation command timed out: ' + ' '.join(str(part) for part in args[:8]))
            BACKGROUND.remove(child)
            if code != 0:
                log.seek(0)
                detail = log.read().strip()
                raise RuntimeError('Preparation command failed' + ((': ' + detail[-1500:]) if detail else ''))

        def ensure_native_toolchain(env):
            missing = [name for name in ['g++', 'make', 'python3'] if shutil.which(name, path=env.get('PATH')) is None]
            if not missing:
                return
            apt = shutil.which('apt-get', path=env.get('PATH'))
            if apt is None:
                raise RuntimeError('npm native modules need ' + ', '.join(missing))
            prefix = []
            if os.geteuid() != 0:
                sudo = shutil.which('sudo', path=env.get('PATH'))
                if sudo is None:
                    raise RuntimeError('npm native modules need ' + ', '.join(missing))
                prefix = [sudo, '-n']
            apt_env = dict(env)
            apt_env['DEBIAN_FRONTEND'] = 'noninteractive'
            run(prefix + [apt, 'update', '-qq'], root, apt_env, timeout=180)
            run(prefix + [apt, 'install', '-y', '-qq', '--no-install-recommends', 'build-essential', 'python3'], root, apt_env, timeout=300)

        def bundled_node_gyp(npm):
            package = pathlib.Path(npm).resolve().parent.parent / 'node_modules' / 'node-gyp'
            try:
                major = int(json.loads((package / 'package.json').read_text())['version'].split('.')[0])
            except (OSError, ValueError, KeyError):
                return None
            script = package / 'bin' / 'node-gyp.js'
            return script if major >= 11 and script.is_file() else None

        def resolve_nodedir(env):
            prefixes = []
            node = shutil.which('node', path=env.get('PATH'))
            if node:
                prefixes.append(pathlib.Path(node).resolve().parent.parent)
            prefixes.extend([pathlib.Path('/usr/local'), pathlib.Path('/usr')])
            seen = set()
            for prefix in prefixes:
                key = str(prefix)
                if key in seen:
                    continue
                seen.add(key)
                if (prefix / 'include' / 'node' / 'node.h').is_file():
                    return str(prefix)
            return None

        repository = spec['repository']
        runtime = spec.get('runtime') or spec['artifact']
        hashes = [(spec['artifact']['revision'], 40), (spec['artifact']['sha256'], 64), (runtime['revision'], 40), (runtime['sha256'], 64), (spec['requestHash'], 64), (spec['preparationHash'], 64)]
        if repository is not None:
            hashes.append((repository['revision'], 40))
        for value, length in hashes:
            if not re.fullmatch('[0-9a-f]{' + str(length) + '}', value):
                raise RuntimeError('Expected an exact revision or hash')
        intent = hashlib.sha256(json.dumps({key: value for key, value in spec.items() if key not in ('artifactSources', 'runtime', 'follow', 'refreshOnly')}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        journal_path = root / 'preparation.json'
        if journal_path.exists():
            journal = json.loads(journal_path.read_text())
            if journal['intent'] != intent:
                raise RuntimeError('Preparation identity conflict')
        else:
            journal = {'intent': intent, 'environmentId': str(uuid.uuid4()), 'installedFiles': []}
            atomic(journal_path, json.dumps(journal))
        home = root / 'home'
        home.mkdir(exist_ok=True)
        t3home = home / '.t3'
        local_bin = home / '.local' / 'bin'
        local_bin.mkdir(parents=True, exist_ok=True)
        # nsc exec python3 is not a login shell. Capture the guest login PATH
        # before HOME is remapped, so npm and curl stay resolvable.
        probing = time.monotonic()
        login = subprocess.run(['sh', '-lc', 'printf %s "$PATH"'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30)
        mark('loginPath', probing)
        base_path = login.stdout.strip() if login.returncode == 0 and login.stdout.strip() else os.environ.get('PATH', '')
        env = {key: os.environ[key] for key in ['LANG', 'TMPDIR', 'SYSTEMROOT', 'DEVELOPER_DIR'] if key in os.environ}
        env.update({
            'HOME': str(home),
            'T3CODE_HOME': str(t3home),
            'NPM_CONFIG_PREFIX': str(home / '.local'),
            'PATH': str(local_bin) + os.pathsep + base_path,
            'GIT_TERMINAL_PROMPT': '0',
            'GIT_ASKPASS': os.devnull,
            'GCM_INTERACTIVE': 'never',
            'GIT_LFS_SKIP_SMUDGE': '1',
            # t3 serve forces this off. Cloud guests must publish the cloned workspace.
            'T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD': '1',
        })
        project = root / 'workspace'
        def install_files(scope):
            for index, file in enumerate(spec['files']):
                if file['scope'] != scope:
                    continue
                if index in journal['installedFiles']:
                    continue
                data = base64.b64decode(file['contentsBase64'], validate=True)
                if hashlib.sha256(data).hexdigest() != file['sha256']:
                    raise RuntimeError('Transferred file digest mismatch')
                if file['scope'] not in ['home', 'workspace']:
                    raise RuntimeError('Invalid transferred file scope')
                target = contained(home if file['scope'] == 'home' else project, file['destination'])
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists():
                    if digest(target) != file['sha256']:
                        raise RuntimeError('Refusing to overwrite an existing workspace or credential file')
                else:
                    temp = target.with_name(target.name + '.preparing')
                    with open(temp, 'wb') as output:
                        output.write(data)
                        output.flush()
                        os.fsync(output.fileno())
                    os.replace(temp, target)
                target.chmod(0o600)
                journal['installedFiles'].append(index)
                atomic(journal_path, json.dumps(journal))
        git_env = dict(env)
        if repository is not None and repository.get('accessToken'):
            token = repository['accessToken']
            git_env.update({
                'GIT_CONFIG_COUNT': '1',
                'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
                'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode(),
            })
        def fetch_followed():
            # Best effort: the thread sees new pushes through the remote ref
            # and pulls them itself. HEAD is never moved under its work.
            follow = spec.get('follow')
            if repository is None or not follow:
                return None
            try:
                if follow == 'HEAD':
                    default = re.search(r'^ref: refs/heads/(\S+)\tHEAD$', run(['git', 'ls-remote', '--symref', 'origin', 'HEAD'], project, git_env, timeout=30), re.M)
                    if default is None:
                        raise RuntimeError('The repository does not advertise a default branch')
                    follow = default.group(1)
                tracking = 'refs/remotes/origin/' + follow
                run(['git', 'check-ref-format', tracking], project, env)
                # No --depth: a shallow checkout already fetches only back to
                # its boundary, and deepening would take shallow.lock.
                run(['git', '-c', 'protocol.version=2', 'fetch', '--no-tags', 'origin', '+refs/heads/' + follow + ':' + tracking], project, git_env, timeout=30)
                return None
            except Exception as error:
                return str(error)
        if spec.get('refreshOnly'):
            if not project.exists():
                raise RuntimeError('The workspace has not been prepared')
            with step('repositoryRefresh'):
                refresh_error = fetch_followed()
            return {'refreshError': refresh_error, 'phases': phases}
        with step('homeFiles'):
            install_files('home')
        # Agent CLIs install into the isolated home, independent of the runtime
        # and the checkout, so they download while those do. Setup commands may
        # call the CLIs, so preparation waits for this before running them.
        install = spec.get('providerInstall')
        installing = None
        if install:
            if not isinstance(install, str) or not install.strip() or '\0' in install:
                raise RuntimeError('Invalid provider install command')
            installing = start(['sh', '-c', install], home, env)
        checkout = root / 'workspace.partial'
        fetching = None
        if repository is not None and not project.exists():
            # Keep a partial clone across retries. Wiping it restarts a
            # large fetch from zero after every timeout.
            if not (checkout / '.git').is_dir():
                if checkout.exists():
                    shutil.rmtree(checkout)
                checkout.mkdir()
                run(['git', 'init', '-q', str(checkout)], root, env)
                run(['git', 'remote', 'add', 'origin', repository['url']], checkout, git_env)
            elif run(['git', 'remote', 'get-url', 'origin'], checkout, env) != repository['url']:
                raise RuntimeError('Repository identity conflict')
            # Nothing but this locked preparer touches the partial clone, so a
            # shallow.lock here was stranded by a fetch killed mid-way.
            (checkout / '.git' / 'shallow.lock').unlink(missing_ok=True)
            # Shallow, with blobs: checkout needs every blob of this one
            # commit, and fetching them in the pack is about twice as fast
            # as a blobless fetch that backfills them on checkout. It
            # downloads while the runtime installs.
            fetching = start(['git', '-c', 'protocol.version=2', 'fetch', '--depth=1', '--no-tags', 'origin', repository['revision']], checkout, git_env)
        # The identity build keeps its pre-upgrade layout so every existing
        # root verifies unchanged; any other build lives beside it by digest.
        legacy = runtime['sha256'] == spec['artifact']['sha256']
        artifact = root / 'artifact' if legacy else root / 'runtime' / runtime['sha256']
        def recorded_snapshot():
            if legacy:
                return {'files': journal.get('artifactFiles'), 'links': journal.get('artifactLinks', {})}
            return journal.get('runtimes', {}).get(runtime['sha256'])
        def record_snapshot(files, links):
            if legacy:
                journal['artifactFiles'], journal['artifactLinks'] = files, links
            else:
                journal.setdefault('runtimes', {})[runtime['sha256']] = {'files': files, 'links': links}
        if not artifact.exists():
            with step('artifactExtract'):
                if digest(runtime['archivePath']) != runtime['sha256']:
                    raise RuntimeError('Artifact digest mismatch')
                artifact.parent.mkdir(parents=True, exist_ok=True)
                stage = artifact.with_name(artifact.name + '.partial')
                if stage.exists():
                    shutil.rmtree(stage)
                stage.mkdir()
                with tarfile.open(runtime['archivePath']) as archive:
                    members = []
                    links = []
                    for member in archive.getmembers():
                        if member.isdir() and pathlib.PurePosixPath(member.name) in (pathlib.PurePosixPath('.'), pathlib.PurePosixPath('./')):
                            continue
                        if member.issym() or member.islnk():
                            links.append(member)
                        else:
                            members.append(member)
                    for member in members:
                        target = contained(stage, member.name)
                        if member.isdir():
                            target.mkdir(parents=True, exist_ok=True)
                        elif member.isfile():
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with archive.extractfile(member) as source, open(target, 'wb') as destination:
                                shutil.copyfileobj(source, destination)
                            target.chmod(0o700 if member.mode & 0o111 else 0o600)
                        else:
                            raise RuntimeError('Artifact must contain only regular files and directories')
                    for member in links:
                        target = contained(stage, member.name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        if member.islnk():
                            source = contained(stage, member.linkname)
                            if not source.is_file() or source.is_symlink():
                                raise RuntimeError('Artifact hard links must point at extracted files')
                            os.link(source, target)
                        else:
                            contained_link(stage, target, member.linkname)
                            os.symlink(member.linkname, target)
                install = runtime.get('install')
                if install is not None and install != 'npm':
                    raise RuntimeError('Unsupported runtime artifact installer')
                if install == 'npm':
                    if not (stage / 'package.json').is_file() or not (stage / 'package-lock.json').is_file():
                        raise RuntimeError('npm runtime artifact requires package.json and package-lock.json')
                    npm = shutil.which('npm')
                    if npm is None:
                        raise RuntimeError('npm runtime artifact requires npm on the target host')
                    npm_env = dict(env)
                    # A tarball that already has node_modules was built for this OS.
                    # Lockfile-only artifacts compile node-pty on the guest; Node 24
                    # cannot rebuild it with the node-gyp 9 that install scripts find.
                    if not (stage / 'node_modules').is_dir():
                        package_lock = json.loads((stage / 'package-lock.json').read_text())
                        needs_native = any((pkg or {}).get('hasInstallScript') for pkg in (package_lock.get('packages') or {}).values())
                        if needs_native:
                            ensure_native_toolchain(npm_env)
                            # npm 11 bundles a node-gyp new enough for Node 24; only an
                            # older npm needs one installed beside it.
                            gyp_js = bundled_node_gyp(npm)
                            if gyp_js is None:
                                gyp_prefix = pathlib.Path(env.get('TMPDIR', '/tmp')) / 't3-node-gyp'
                                gyp_js = gyp_prefix / 'lib' / 'node_modules' / 'node-gyp' / 'bin' / 'node-gyp.js'
                                if not gyp_js.is_file():
                                    run([npm, 'install', '--global', '--prefix', str(gyp_prefix), '--no-audit', '--no-fund', 'node-gyp@11'], stage, npm_env, timeout=180)
                                npm_env['PATH'] = str(gyp_prefix / 'bin') + os.pathsep + npm_env.get('PATH', '')
                            npm_env['npm_config_node_gyp'] = str(gyp_js)
                            python = shutil.which('python3', path=npm_env.get('PATH'))
                            if python:
                                npm_env['npm_config_python'] = python
                            # E2B egress often blocks nodejs.org; official Node installs already have headers.
                            nodedir = resolve_nodedir(npm_env)
                            if nodedir:
                                npm_env['npm_config_nodedir'] = nodedir
                        with step('npmInstall'):
                            run([npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], stage, npm_env, timeout=600)
                record_snapshot(*artifact_snapshot(stage))
                atomic(journal_path, json.dumps(journal))
                os.rename(stage, artifact)
        with step('artifactVerify'):
            actual_files, actual_links = artifact_snapshot(artifact)
            expected = recorded_snapshot()
            if expected is None or actual_files != expected['files'] or actual_links != expected['links']:
                raise RuntimeError('Installed artifact changed')
        entrypoint = contained(artifact, runtime['entrypoint'])
        command = [spec['runtimeExecutable'], str(entrypoint)]
        userdata = t3home / 'userdata'
        userdata.mkdir(parents=True, exist_ok=True)
        environment_path = userdata / 'environment-id'
        if environment_path.exists() and environment_path.read_text().strip() != journal['environmentId']:
            raise RuntimeError('Environment identity conflict')
        if not environment_path.exists():
            atomic(environment_path, journal['environmentId'] + '\n')
        if not project.exists():
            with step('repositoryClone'):
                if repository is None:
                    if checkout.exists():
                        shutil.rmtree(checkout)
                    checkout.mkdir()
                    run(['git', 'init', '-q', str(checkout)], root, env)
                    run(['git', '-c', 'user.name=T3', '-c', 'user.email=agent@t3.local', 'commit', '--allow-empty', '-qm', 'Initialize workspace'], checkout, git_env)
                else:
                    finish(fetching, 600)
                    run(['git', 'checkout', '--detach', repository['revision']], checkout, git_env, timeout=600)
                os.rename(checkout, project)
        if repository is not None:
            with step('repositoryVerify'):
                if run(['git', 'remote', 'get-url', 'origin'], project, env) != repository['url']:
                    raise RuntimeError('Repository identity conflict')
                run(['git', 'merge-base', '--is-ancestor', repository['revision'], 'HEAD'], project, env)
        with step('repositoryRefresh'):
            refresh_error = fetch_followed()
        with step('workspaceFiles'):
            install_files('workspace')
        def fetch_artifact(url, target, expected):
            temp = target.with_name(target.name + '.preparing')
            try:
                result = hashlib.sha256()
                with urllib.request.urlopen(url, timeout=60) as response, open(temp, 'wb') as output:
                    for chunk in iter(lambda: response.read(1024 * 1024), b''):
                        result.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if result.hexdigest() != expected:
                    raise RuntimeError('Artifact download digest mismatch')
                os.replace(temp, target)
            except OSError as error:
                raise RuntimeError('Artifact download failed: ' + str(error))
            finally:
                if temp.exists():
                    temp.unlink()
            target.chmod(0o600)
        artifacts = spec.get('artifacts') or []
        if artifacts:
            sources = {source['path']: source['url'] for source in spec.get('artifactSources') or []}
            with step('artifacts'):
                for entry in artifacts:
                    url = sources.get(entry['path'])
                    if not url:
                        raise RuntimeError('Artifact has no download source: ' + entry['path'])
                    target = contained(home, entry['destination'])
                    target.parent.mkdir(parents=True, exist_ok=True)
                    if target.exists():
                        if digest(target) != entry['sha256']:
                            raise RuntimeError('Refusing to overwrite an existing artifact')
                        continue
                    fetch_artifact(url, target, entry['sha256'])
        if installing is not None:
            with step('providerInstall'):
                finish(installing, 900)
        prepare = spec.get('prepareCommands') or []
        if prepare:
            if not isinstance(prepare, list):
                raise RuntimeError('Invalid prepare commands')
            with step('prepareCommands'):
                for command_line in prepare:
                    if not isinstance(command_line, str) or not command_line.strip() or '\0' in command_line:
                        raise RuntimeError('Invalid prepare command')
                    run(['sh', '-lc', command_line], project, env, timeout=1800)
        credential_path = root / 'broker-token'
        if not credential_path.exists():
            with step('brokerToken'):
                token = run(command + ['auth', 'session', 'issue', '--base-dir', str(t3home), '--ttl', spec['brokerTtl'], '--subject', 'provision-broker', '--token-only'], project, env)
                if not token or any(c.isspace() for c in token):
                    raise RuntimeError('Invalid broker credential output')
                atomic(credential_path, token)
        token = credential_path.read_text()
        origin = 'http://127.0.0.1:' + str(spec['port'])
        def probe():
            try:
                with urllib.request.urlopen(origin + '/.well-known/t3/environment', timeout=2) as response:
                    descriptor = json.load(response)
            except (OSError, ValueError):
                return False
            if descriptor.get('environmentId') != journal['environmentId']:
                raise RuntimeError('Port belongs to another environment')
            request = urllib.request.Request(origin + '/api/auth/session', headers={'Authorization': 'Bearer ' + token})
            try:
                with urllib.request.urlopen(request, timeout=2) as response:
                    session = json.load(response)
                return session.get('authenticated') is True and session.get('sessionMethod') == 'bearer-access-token' and ${JSON.stringify(AuthAccessWriteScope)} in session.get('scopes', [])
            except (OSError, ValueError):
                return False
        server_path = root / 'server.json'
        def server_process():
            try:
                process = json.loads(server_path.read_text())
            except (OSError, ValueError):
                return None
            # A server started before builds were recorded runs the identity build.
            return {'pid': process['pid'], 'sha256': process.get('sha256', spec['artifact']['sha256']), 'revision': process.get('revision', spec['artifact']['revision'])}
        def server_lock_free():
            with open(root / 'server.lock', 'a') as held:
                try:
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return False
                return True
        def stop_server(pid):
            for signal, grace in ((15, 30), (9, 10)):
                try:
                    os.kill(pid, signal)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + grace
                while not server_lock_free():
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.1)
                else:
                    return
            raise RuntimeError('Running server did not stop for the upgrade')
        healthy = probe()
        process = server_process()
        if not (healthy and process is not None and process['sha256'] == runtime['sha256']):
            with step('serverStart'):
                if healthy and process is not None:
                    stop_server(process['pid'])
                # serve is headless and forces auto-bootstrap off, so the client
                # pairs to an empty environment. start --no-browser keeps the same
                # bind, and the cwd argument is the path we report as projectDir.
                config = {'root': str(root), 'build': {'sha256': runtime['sha256'], 'revision': runtime['revision']}, 'argv': command + ['start', '--base-dir', str(t3home), '--no-browser', '--auto-bootstrap-project-from-cwd', '--host', '0.0.0.0', '--port', str(spec['port']), str(project)], 'cwd': str(project), 'env': env}
                with open(root / 'server.log', 'a') as log:
                    subprocess.Popen([sys.executable, '-c', SUPERVISOR, json.dumps(config)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                deadline = time.monotonic() + spec['readinessTimeoutSeconds']
                while not probe():
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Prepared server did not become authenticated and ready')
                    time.sleep(0.1)
        # t3 serve never creates a project. Add the checkout explicitly so
        # pairing can hand off even when an older guest is already running.
        # The checkout directory is always workspace, so title the project
        # after the repository instead of the directory.
        with step('projectAdd'):
            title = []
            if repository is not None:
                name = repository['url'].rstrip('/').rsplit('/', 1)[-1]
                if name.endswith('.git'):
                    name = name[:-4]
                if name:
                    title = ['--title', name]
            added = subprocess.run(
                command + ['project', 'add', '--base-dir', str(t3home), *title, str(project)],
                cwd=str(project),
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                pass_fds=(lock.fileno(),),
                timeout=30,
            )
        if added.returncode != 0:
            detail = (added.stderr or added.stdout or '').strip()
            if 'already exists' not in detail.lower():
                raise RuntimeError('Could not add the workspace as a project' + ((': ' + detail[-1500:]) if detail else ''))
        process = server_process()
        if process is None or process['sha256'] != runtime['sha256']:
            raise RuntimeError('Prepared server is not running the requested build')
        mark('prepareTotal', entered)
        return {'refreshError': refresh_error, 'environmentId': journal['environmentId'], 'projectDir': str(project), 'sourceRevision': repository['revision'] if repository else None, 'headRevision': run(['git', 'rev-parse', 'HEAD'], project, env), 'preparationHash': spec['preparationHash'], 't3Revision': process['revision'], 'artifactSha256': process['sha256'], 'runtimeVersion': run([spec['runtimeExecutable'], '--version'], root, env), 'serverPid': process['pid'], 'brokerCredentialPath': str(credential_path), 'phases': phases}

SUPERVISOR = r"""
import fcntl,json,os,pathlib,sys
os.umask(0o077)
config = json.loads(sys.argv[1])
root = pathlib.Path(config['root'])
with open(root / 'server.lock', 'a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    with open(root / 'server.json.tmp', 'w') as output:
        json.dump({'pid': os.getpid(), **config['build']}, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(root / 'server.json.tmp', root / 'server.json')
    os.chdir(config['cwd'])
    os.set_inheritable(lock.fileno(), True)
    os.execvpe(config['argv'][0], config['argv'], config['env'])
"""

try:
    reading = time.monotonic()
    STARTUP.append({'phase': 'moduleInit', 'durationMs': round((reading - INTERPRETER_START) * 1000)})
    payload = sys.stdin.read()
    STARTUP.append({'phase': 'stdinRead', 'durationMs': round((time.monotonic() - reading) * 1000), 'bytes': len(payload)})
    print(json.dumps(prepare(json.loads(payload))))
except Exception as error:
    for child in BACKGROUND:
        with contextlib.suppress(OSError):
            os.killpg(child.pid, 9)
    sys.stderr.write('Remote preparation failed: ' + str(error) + '\n')
    sys.exit(1)
`;
