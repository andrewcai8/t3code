/**
 * A Modal gVisor box keeps, across a memory snapshot, only the processes descended from its
 * entrypoint; one a guest script detaches from inside an exec is frozen for good. So a Modal box's
 * entrypoint is `guestInitScript`, which starts what guests ask it to as its own children, and a
 * guest starts every long-lived process through `spawn_detached` from `spawnDetachedScript`.
 */

/** Where a box's entrypoint listens. A guest that finds no socket here detaches the process itself. */
export const GUEST_INIT_SOCKET = "/run/t3-init.sock";

/**
 * The entrypoint. Argument: the socket path. Each connection sends one JSON line,
 * `{argv, env, cwd, log}`, and reads back `{pid}` or `{error}`. The process runs as the caller's
 * user, in a session of its own, with stdout and stderr appended to `log`. Every child is reaped,
 * including orphans reparented to this process.
 */
export const guestInitScript = String.raw`
import json, os, pwd, signal, socket, struct, sys
path = sys.argv[1]

def reap(*_):
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return

def peer_uid(conn):
    if hasattr(socket, 'SO_PEERCRED'):
        return struct.unpack('3i', conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i')))[1]
    # Without peer credentials only an unprivileged entrypoint is safe: it can start nothing but itself.
    if os.geteuid() == 0:
        raise RuntimeError('peer credentials are unavailable')
    return os.geteuid()

def start(request, uid):
    pid = os.fork()
    if pid != 0:
        return pid
    try:
        os.setsid()
        if os.geteuid() == 0 and uid != 0:
            user = pwd.getpwuid(uid)
            os.initgroups(user.pw_name, user.pw_gid)
            os.setgid(user.pw_gid)
            os.setuid(uid)
        os.umask(0o077)
        log = os.open(request['log'], os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        devnull = os.open(os.devnull, os.O_RDONLY)
        os.dup2(devnull, 0)
        os.dup2(log, 1)
        os.dup2(log, 2)
        os.closerange(3, 65536)
        if request.get('cwd'):
            os.chdir(request['cwd'])
        os.execvpe(request['argv'][0], request['argv'], request['env'])
    finally:
        os._exit(127)

signal.signal(signal.SIGCHLD, reap)
try:
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(path)
# Any user may ask; each process runs as whoever asked.
os.chmod(path, 0o666)
server.listen(16)
print('listening', flush=True)
while True:
    conn, _ = server.accept()
    with conn:
        try:
            uid = peer_uid(conn)
            request = json.loads(conn.makefile().readline())
            reply = {'pid': start(request, uid)}
        except Exception as error:
            reply = {'error': str(error)}
        try:
            conn.sendall(json.dumps(reply).encode() + b'\n')
        except OSError:
            pass
`;

/**
 * Defines `spawn_detached(argv, env, cwd, log_path)`, which starts a process that outlives the
 * guest script and returns its pid: through the box's entrypoint when it serves
 * `T3_INIT_SOCKET` (default `GUEST_INIT_SOCKET`), otherwise detached here, as on E2B.
 */
export const spawnDetachedScript = String.raw`
def spawn_detached(argv, env, cwd, log_path):
    import json as _json, os as _os, socket as _socket, subprocess as _subprocess
    path = _os.environ.get('T3_INIT_SOCKET', ${JSON.stringify(GUEST_INIT_SOCKET)})
    if _os.path.exists(path):
        with _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM) as conn:
            conn.settimeout(30)
            conn.connect(path)
            conn.sendall(_json.dumps({'argv': [str(part) for part in argv], 'env': dict(env), 'cwd': cwd and str(cwd), 'log': str(log_path)}).encode() + b'\n')
            reply = _json.loads(conn.makefile().readline())
        if 'pid' not in reply:
            raise RuntimeError('The box could not start ' + str(argv[0]) + ': ' + str(reply.get('error')))
        return reply['pid']
    with open(log_path, 'a') as log:
        return _subprocess.Popen(argv, cwd=cwd, env=env, stdin=_subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True).pid
`;
