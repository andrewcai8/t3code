#!/usr/bin/env bash
# A provisioning manager on this machine, built from this checkout and isolated from every other
# T3 home. It is the fast loop for provisioning work and what smoke-cloud-chat.ts runs against.
#
#   scripts/cloud/local-manager.sh start   # build, seed, serve on 127.0.0.1, mint a pairing token
#   scripts/cloud/local-manager.sh pair    # mint a fresh pairing token for the running manager
#   scripts/cloud/local-manager.sh stop    # stop the manager this script started
#
# SOURCE_HOME (default ~/.t3/fork-dev) supplies environment-control.json, settings.json, the
# provider secrets and the Cursor homes. They are copied, never linked, into MANAGER_HOME
# (default <checkout>/.t3/manager), and nothing is ever written back. The runtime artifact both
# linux and macos boxes install is rebuilt from this checkout and pinned by sha256 and revision.
# PORT defaults to a free port. The pairing token lands in $MANAGER_HOME/pairing-token (0600).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SOURCE_HOME=${SOURCE_HOME:-$HOME/.t3/fork-dev}
MANAGER_HOME=${MANAGER_HOME:-$ROOT/.t3/manager}
PID_FILE=$MANAGER_HOME/manager.pid
PORT_FILE=$MANAGER_HOME/manager.port
LOG=$MANAGER_HOME/manager.log
TOKEN_FILE=$MANAGER_HOME/pairing-token
[[ $MANAGER_HOME != "$SOURCE_HOME" ]] || { echo "MANAGER_HOME must not be SOURCE_HOME" >&2; exit 2; }
T3=(node "$ROOT/apps/server/dist/bin.mjs")

running_pid() {
  [[ -f $PID_FILE ]] || return 1
  local pid
  pid=$(cat "$PID_FILE")
  # A recycled PID belongs to someone else: only a process serving this home counts.
  ps -p "$pid" -o command= 2>/dev/null | grep -qF -- "--base-dir $MANAGER_HOME" || return 1
  echo "$pid"
}

build_artifact() {
  local revision artifact
  revision=$(git -C "$ROOT" rev-parse HEAD)
  [[ -z $(git -C "$ROOT" status --porcelain -- apps/server packages) ]] ||
    echo "warning: apps/server or packages has uncommitted changes; the artifact is not exactly $revision" >&2
  artifact=$MANAGER_HOME/artifacts/runtime-${revision:0:10}.tar.gz
  mkdir -p "$MANAGER_HOME/artifacts"
  node "$ROOT/apps/server/scripts/cli.ts" build >"$MANAGER_HOME/build.log" 2>&1
  rm -f "$artifact"
  # Lockfile-only: each box runs `npm ci` itself, so one archive serves linux and darwin-arm64.
  node "$ROOT/apps/server/scripts/build-runtime-artifact.ts" "$artifact" >>"$MANAGER_HOME/build.log" 2>&1
  echo "$artifact $(shasum -a 256 "$artifact" | cut -d' ' -f1) $revision"
}

seed_home() {
  local artifact=$1 sha=$2 revision=$3
  mkdir -p "$MANAGER_HOME/userdata/secrets"
  chmod 700 "$MANAGER_HOME"
  install -m 600 "$SOURCE_HOME/environment-control.json" "$MANAGER_HOME/environment-control.json"
  node -e '
    const fs = require("node:fs");
    const [file, path, sha256, revision] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const platform of ["linux", "macos"])
      config.provisioning.runtimeArtifacts[platform] = {
        ...config.provisioning.runtimeArtifacts[platform],
        path, sha256, revision,
      };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  ' "$MANAGER_HOME/environment-control.json" "$artifact" "$sha" "$revision"
  # Cursor instances name their homes by absolute path; point them at the copies.
  rm -rf "$MANAGER_HOME/userdata/cursor-homes"
  cp -R "$SOURCE_HOME/userdata/cursor-homes" "$MANAGER_HOME/userdata/cursor-homes"
  sed "s#$SOURCE_HOME/userdata/#$MANAGER_HOME/userdata/#g" "$SOURCE_HOME/userdata/settings.json" \
    >"$MANAGER_HOME/userdata/settings.json"
  install -m 600 "$SOURCE_HOME"/userdata/secrets/provider-env-*.bin "$MANAGER_HOME/userdata/secrets/"
}

free_port() {
  node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); });'
}

mint_token() {
  local port
  port=$(cat "$PORT_FILE")
  (
    umask 077
    "${T3[@]}" auth pairing create --base-dir "$MANAGER_HOME" --ttl 12h --label "local smoke" --json 2>/dev/null |
      node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).credential));' \
        >"$TOKEN_FILE"
  )
  [[ -s $TOKEN_FILE ]] || { echo "could not mint a pairing token" >&2; exit 1; }
  echo "origin http://127.0.0.1:$port  token $TOKEN_FILE"
}

start() {
  if pid=$(running_pid); then
    echo "already running: pid $pid on port $(cat "$PORT_FILE")"
    return
  fi
  read -r artifact sha revision < <(build_artifact)
  seed_home "$artifact" "$sha" "$revision"
  echo "artifact $artifact sha256 $sha revision $revision"
  local port=${PORT:-$(free_port)}
  (
    umask 077
    # The serve banner carries a pairing URL, so the log stays private.
    nohup "${T3[@]}" serve --base-dir "$MANAGER_HOME" --host 127.0.0.1 --port "$port" "$MANAGER_HOME" \
      >"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
  )
  echo "$port" >"$PORT_FILE"
  local waited=0
  until curl -fsS -m 2 "http://127.0.0.1:$port/.well-known/t3/environment" >/dev/null 2>&1; do
    running_pid >/dev/null || { echo "manager exited; see $LOG" >&2; exit 1; }
    ((++waited < 120)) || { echo "manager not healthy after 120s; see $LOG" >&2; exit 1; }
    sleep 1
  done
  echo "manager pid $(cat "$PID_FILE") on http://127.0.0.1:$port (log $LOG)"
  mint_token
}

stop() {
  local pid
  if ! pid=$(running_pid); then
    echo "not running"
    rm -f "$PID_FILE"
    return
  fi
  kill "$pid"
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "stopped pid $pid"
      return
    fi
    sleep 1
  done
  echo "pid $pid is still running after 30s" >&2
  exit 1
}

case ${1:-} in
  start) start ;;
  pair)
    running_pid >/dev/null || { echo "not running" >&2; exit 1; }
    mint_token
    ;;
  stop) stop ;;
  *)
    echo "usage: $0 start|pair|stop" >&2
    exit 2
    ;;
esac
