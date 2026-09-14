import { AuthAccessWriteScope, ProvisionReadiness } from "@t3tools/contracts";
import { Schema } from "effect";

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
}

export const RemotePreparationReady = Schema.Struct({
  ...ProvisionReadiness.fields,
  headRevision: ProvisionReadiness.fields.t3Revision,
  artifactSha256: ProvisionReadiness.fields.preparationHash,
  runtimeVersion: Schema.String,
  serverPid: Schema.Int,
  brokerCredentialPath: Schema.String,
});
export type RemotePreparationReady = typeof RemotePreparationReady.Type;
const decodeReady = Schema.decodeUnknownSync(Schema.fromJsonString(RemotePreparationReady));

/** The transport must send stdin privately and must not log it or remote private files. */
export interface RemotePreparationPort {
  executePython(input: {
    readonly script: string;
    readonly stdin: string;
  }): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

export async function prepareRemoteHost(
  port: RemotePreparationPort,
  input: RemotePreparationInput,
): Promise<RemotePreparationReady> {
  const result = await port.executePython({
    script: remotePreparationScript,
    stdin: JSON.stringify(input),
  });
  if (result.exitCode !== 0) throw new Error("Remote preparation failed.");
  return decodeReady(result.stdout);
}

/** Python's kernel locks work on Linux and macOS and release when a preparation process dies. */
export const remotePreparationScript = String.raw`
import base64, fcntl, hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time, urllib.request, uuid

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
    target = root / relative
    if pathlib.Path(relative).is_absolute() or target.resolve() == root.resolve() or root.resolve() not in target.resolve().parents:
        raise RuntimeError('Path escapes its preparation directory')
    if target.is_symlink():
        raise RuntimeError('Symlink destinations are not supported')
    return target

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
    root = pathlib.Path(spec['root'])
    if not root.is_absolute() or root.is_symlink():
        raise RuntimeError('Preparation requires a private absolute root')
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('Preparation root must be private to its owner')
    with open(root / 'prepare.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        def run(args, cwd, env):
            # A surviving Git or auth child retains the lock if its preparer dies.
            result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, pass_fds=(lock.fileno(),))
            if result.returncode != 0:
                raise RuntimeError('Preparation command failed')
            return result.stdout.strip()

        repository = spec['repository']
        hashes = [(spec['artifact']['revision'], 40), (spec['artifact']['sha256'], 64), (spec['requestHash'], 64), (spec['preparationHash'], 64)]
        if repository is not None:
            hashes.append((repository['revision'], 40))
        for value, length in hashes:
            if not re.fullmatch('[0-9a-f]{' + str(length) + '}', value):
                raise RuntimeError('Expected an exact revision or hash')
        intent = hashlib.sha256(json.dumps(spec, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
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
        env = {key: os.environ[key] for key in ['PATH', 'LANG', 'TMPDIR', 'SYSTEMROOT'] if key in os.environ}
        env.update({'HOME': str(home), 'T3CODE_HOME': str(t3home)})
        artifact = root / 'artifact'
        if not artifact.exists():
            if digest(spec['artifact']['archivePath']) != spec['artifact']['sha256']:
                raise RuntimeError('Artifact digest mismatch')
            stage = root / 'artifact.partial'
            if stage.exists():
                shutil.rmtree(stage)
            stage.mkdir()
            with tarfile.open(spec['artifact']['archivePath']) as archive:
                for member in archive.getmembers():
                    if member.isdir() and pathlib.PurePosixPath(member.name) == pathlib.PurePosixPath('.'):
                        continue
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
            install = spec['artifact'].get('install')
            if install is not None and install != 'npm':
                raise RuntimeError('Unsupported runtime artifact installer')
            if install == 'npm':
                if not (stage / 'package.json').is_file() or not (stage / 'package-lock.json').is_file():
                    raise RuntimeError('npm runtime artifact requires package.json and package-lock.json')
                npm = shutil.which('npm')
                if npm is None:
                    raise RuntimeError('npm runtime artifact requires npm on the target host')
                run([npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'], stage, env)
            journal['artifactFiles'], journal['artifactLinks'] = artifact_snapshot(stage)
            atomic(journal_path, json.dumps(journal))
            os.rename(stage, artifact)
        actual_files, actual_links = artifact_snapshot(artifact)
        if actual_files != journal.get('artifactFiles') or actual_links != journal.get('artifactLinks', {}):
            raise RuntimeError('Installed artifact changed')
        entrypoint = contained(artifact, spec['artifact']['entrypoint'])
        command = [spec['runtimeExecutable'], str(entrypoint)]
        userdata = t3home / 'userdata'
        userdata.mkdir(parents=True, exist_ok=True)
        environment_path = userdata / 'environment-id'
        if environment_path.exists() and environment_path.read_text().strip() != journal['environmentId']:
            raise RuntimeError('Environment identity conflict')
        if not environment_path.exists():
            atomic(environment_path, journal['environmentId'] + '\n')
        project = root / 'workspace'
        git_env = dict(env)
        if repository is not None and repository.get('accessToken'):
            token = repository['accessToken']
            git_env.update({
                'GIT_CONFIG_COUNT': '1',
                'GIT_CONFIG_KEY_0': 'http.https://github.com/.extraheader',
                'GIT_CONFIG_VALUE_0': 'AUTHORIZATION: basic ' + base64.b64encode(('x-access-token:' + token).encode()).decode(),
            })
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
        install_files('home')
        if not project.exists():
            stage = root / 'workspace.partial'
            if stage.exists():
                shutil.rmtree(stage)
            stage.mkdir()
            run(['git', 'init', '-q', str(stage)], root, env)
            if repository is None:
                run(['git', '-c', 'user.name=T3', '-c', 'user.email=agent@t3.local', 'commit', '--allow-empty', '-qm', 'Initialize workspace'], stage, git_env)
            else:
                run(['git', 'remote', 'add', 'origin', repository['url']], stage, git_env)
                run(['git', 'fetch', '--no-tags', 'origin', repository['revision']], stage, git_env)
                run(['git', 'checkout', '--detach', repository['revision']], stage, git_env)
            os.rename(stage, project)
        if repository is not None:
            if run(['git', 'remote', 'get-url', 'origin'], project, env) != repository['url']:
                raise RuntimeError('Repository identity conflict')
            run(['git', 'merge-base', '--is-ancestor', repository['revision'], 'HEAD'], project, env)
        install_files('workspace')
        credential_path = root / 'broker-token'
        if not credential_path.exists():
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
        if not probe():
            config = {'root': str(root), 'argv': command + ['serve', '--base-dir', str(t3home), '--no-browser', '--host', '0.0.0.0', '--port', str(spec['port'])], 'cwd': str(project), 'env': env}
            with open(root / 'server.log', 'a') as log:
                subprocess.Popen([sys.executable, '-c', SUPERVISOR, json.dumps(config)], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            deadline = time.monotonic() + spec['readinessTimeoutSeconds']
            while not probe():
                if time.monotonic() >= deadline:
                    raise RuntimeError('Prepared server did not become authenticated and ready')
                time.sleep(0.1)
        process = json.loads((root / 'server.json').read_text())
        return {'environmentId': journal['environmentId'], 'projectDir': str(project), 'sourceRevision': repository['revision'] if repository else None, 'headRevision': run(['git', 'rev-parse', 'HEAD'], project, env), 'preparationHash': spec['preparationHash'], 't3Revision': spec['artifact']['revision'], 'artifactSha256': spec['artifact']['sha256'], 'runtimeVersion': run([spec['runtimeExecutable'], '--version'], root, env), 'serverPid': process['pid'], 'brokerCredentialPath': str(credential_path)}

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
        json.dump({'pid': os.getpid()}, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(root / 'server.json.tmp', root / 'server.json')
    os.chdir(config['cwd'])
    os.set_inheritable(lock.fileno(), True)
    os.execvpe(config['argv'][0], config['argv'], config['env'])
"""

try:
    print(json.dumps(prepare(json.load(sys.stdin))))
except Exception as error:
    sys.stderr.write('Remote preparation failed: ' + str(error) + '\n')
    sys.exit(1)
`;
