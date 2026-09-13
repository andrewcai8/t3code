import { workloadCommand } from "@t3tools/shared/workload";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function e2bStartCommand(input: {
  readonly executable: string;
  readonly path: string;
  readonly projectDir: string;
  readonly port: number;
}) {
  const preflight = workloadCommand("/bin/true", []);
  const enterWorkloads = [preflight.command, ...preflight.args].map(shellQuote).join(" ");
  const serve = `set -eu
printf '%s\\n' "$$" > /sys/fs/cgroup/t3/control/cgroup.procs
setpriv --reuid=user --regid=user --init-groups -- ${enterWorkloads}
cd ${shellQuote(input.projectDir)}
exec setpriv --reuid=user --regid=user --init-groups -- env HOME=/home/user PATH=${shellQuote(input.path)} T3CODE_WORKLOAD_ISOLATION=1 ${shellQuote(input.executable)} serve --no-browser --host 0.0.0.0 --port ${input.port}`;
  return `set -eu
cg=/sys/fs/cgroup/t3
mkdir -p "$cg"
printf '+memory\\n' > "$cg/cgroup.subtree_control"
mkdir -p "$cg/control" "$cg/workloads"
bytes=$(awk '/^MemTotal:/ {total = $2 * 1024; reserve = total * 0.2; if (reserve < 1073741824) reserve = 1073741824; printf "%.0f", total - reserve}' /proc/meminfo)
if [ "$bytes" -lt 536870912 ]; then
  echo "E2B memory is too small to reserve space for T3 and its connection service" >&2
  exit 1
fi
printf '%s\\n' "$bytes" > "$cg/workloads/memory.max"
printf '0\\n' > "$cg/workloads/memory.oom.group"
chown user:user "$cg/cgroup.procs" "$cg/workloads/cgroup.procs"
nohup setsid /bin/sh -c ${shellQuote(serve)} > /tmp/serve.out 2>&1 < /dev/null &
printf '%s\\n' "$!"
`;
}

export function e2bStopInheritedServerCommand(port: number, projectDir: string) {
  return `python3 - ${port} ${shellQuote(projectDir)} <<'PY'
import os, re, signal, subprocess, sys, time
listeners = subprocess.check_output(['ss', '-H', '-ltnp', 'sport = :' + sys.argv[1]], text=True)
pids = set(re.findall(r'pid=(\\d+)', listeners))
if len(pids) > 1:
    raise RuntimeError('Multiple processes own the T3 port')
for pid in pids:
    cwd = os.readlink('/proc/' + pid + '/cwd')
    args = open('/proc/' + pid + '/cmdline', 'rb').read().split(b'\\x00')
    if cwd not in ['/home/user/work', sys.argv[2]] or b'serve' not in args:
        raise RuntimeError('Refusing to stop an unexpected process on the T3 port')
    os.kill(int(pid), signal.SIGTERM)
    deadline = time.monotonic() + 10
    while os.path.exists('/proc/' + pid):
        if time.monotonic() > deadline:
            raise RuntimeError('Inherited T3 server did not stop')
        time.sleep(0.1)
PY`;
}
