/**
 * Python that reads, on a cloud box, the environment its chat's agent runs with: the T3 server's
 * own, plus each provider instance's variables, such as the AWS keys the agent uploads with. A
 * guest script embeds it and calls `agent_env(root)` with the box's provision root. It answers
 * `(env, server_pid, t3_home, settings)`; the pid is None when no server is running.
 *
 * Once the server saves its settings, a sensitive variable's value is kept out of settings.json
 * (`value: ""`, `valueRedacted: true`) and lives in the server's secret store as
 * `<t3 home>/userdata/secrets/provider-env-<instance>-<name>.bin`, both parts base64url. This
 * reads it from there, as the server does (serverSettings.ts). A variable whose secret is missing
 * is left out of `env`; `unresolved_env(t3_home, settings)` names them so a caller can say so.
 *
 * `provider_home(env, settings, root, driver, instance_id)` answers where a Claude or Codex
 * instance keeps its sessions: its `homePath`, else `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, else the
 * folder under HOME.
 *
 * Without a running server, as on a machine booted fresh from its disk, where the recorded pid may
 * belong to another process, `env` falls back to what remote preparation starts the server with:
 * its home, T3 home and the home's bin on PATH.
 *
 * @module guestAgentEnvironment
 */
export const agentEnvironmentPython = String.raw`
import base64

def provider_secret(home, instance_id, name):
    part = lambda text: base64.urlsafe_b64encode(text.encode()).decode().rstrip('=')
    try:
        return (home / 'userdata' / 'secrets' / ('provider-env-%s-%s.bin' % (part(instance_id), part(name)))).read_bytes().decode()
    except (OSError, UnicodeDecodeError):
        return None

def provider_variables(home, settings):
    for instance_id, instance in (settings.get('providerInstances') or {}).items():
        for variable in (instance or {}).get('environment') or []:
            if isinstance(variable, dict) and isinstance(variable.get('name'), str) and isinstance(variable.get('value'), str):
                value = variable['value']
                if variable.get('valueRedacted') is True:
                    value = provider_secret(home, instance_id, variable['name'])
                yield variable['name'], value

def unresolved_env(home, settings):
    return sorted({name for name, value in provider_variables(home, settings) if value is None})

def agent_env(root):
    server = None
    env = dict(os.environ)
    try:
        pid = json.loads((root / 'server.json').read_text())['pid']
        raw = pathlib.Path('/proc/%d/environ' % pid).read_bytes().decode(errors='replace')
        live = dict(item.split('=', 1) for item in raw.split('\0') if '=' in item)
        # After a fresh boot the recorded pid can belong to anything; only the server has this.
        if 'T3CODE_HOME' not in live:
            raise KeyError('T3CODE_HOME')
        env, server = live, pid
    except (OSError, ValueError, KeyError, TypeError):
        env['HOME'] = str(root / 'home')
        env['T3CODE_HOME'] = str(root / 'home' / '.t3')
        env['PATH'] = str(root / 'home' / '.local' / 'bin') + os.pathsep + env.get('PATH', '')
    home = pathlib.Path(env.get('T3CODE_HOME', str(root / 'home' / '.t3')))
    settings = {}
    for path in (home / 'userdata' / 'settings.json', home / 'settings.json'):
        try:
            settings = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        for name, value in provider_variables(home, settings):
            if value is not None:
                env[name] = value
        break
    return env, server, home, settings

def provider_home(env, settings, root, driver, instance_id):
    instance = (settings.get('providerInstances') or {}).get(instance_id) or {}
    home_path = (instance.get('config') or {}).get('homePath')
    if home_path:
        return pathlib.Path(home_path)
    variable, folder = ('CLAUDE_CONFIG_DIR', '.claude') if driver == 'claudeAgent' else ('CODEX_HOME', '.codex')
    return pathlib.Path(env.get(variable) or pathlib.Path(env.get('HOME', str(root / 'home'))) / folder)
`;
