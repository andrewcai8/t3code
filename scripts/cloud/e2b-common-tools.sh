#!/usr/bin/env bash
set -euo pipefail

download() {
  curl -fsSL --retry 3 --connect-timeout 30 --max-time 900 "$1" -o "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum --check --status
}

case "${1:-}" in
  system)
    test "$(uname -m)" = x86_64
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod 755 /usr/sbin/policy-rc.d
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends \
      bash ca-certificates curl unzip xz-utils gnupg sudo \
      git gh ripgrep python3 python3-pip python3-venv python3-dev \
      redis-server redis-tools golang-go ruby build-essential pkg-config \
      libcurl4-openssl-dev libsqlite3-dev libicu-dev libxml2-dev \
      libedit-dev libzstd-dev zlib1g-dev tzdata procps openssh-client
    id -u user >/dev/null 2>&1 || useradd --create-home --shell /bin/bash user
    printf 'user ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/t3-user
    chmod 440 /etc/sudoers.d/t3-user
    install -d -o user -g user /home/user/.local /home/user/.local/bin /home/user/.bun /home/user/.bun/bin
    ;;
  runtimes)
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    download \
      https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz \
      "$temporary/node.tar.xz" \
      fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6
    tar -xJf "$temporary/node.tar.xz" --strip-components=1 -C /usr/local
    # Match MeGPT's env-lib.sh CPU selection, npm archive pins, and bunx alias.
    target=bun-linux-x64
    checksum=1e812bd440362ae0a7f99f340a4d1202a1ed6c8e97553c820ffbb6445e576a65
    if ! grep -qs avx2 /proc/cpuinfo; then
      target=bun-linux-x64-baseline
      checksum=e8d1fcb859272945fdb9ed1de1fb787ab8ff4f85c5ad15a0a7134b76b63ceaa5
    fi
    download "https://registry.npmjs.org/@oven/$target/-/$target-1.4.0.tgz" \
      "$temporary/bun.tgz" "$checksum"
    tar -xzf "$temporary/bun.tgz" -C "$temporary" package/bin/bun
    install -m 755 "$temporary/package/bin/bun" /usr/local/bin/bun
    ln -sfn bun /usr/local/bin/bunx
    ln -sfn /usr/local/bin/bun /home/user/.bun/bin/bun
    ln -sfn bun /home/user/.bun/bin/bunx
    test "$(node --version)" = v24.21.0
    test "$(bun --version)" = 1.4.0
    ;;
  tools)
    test "$HOME" = /home/user
    npm install --global --no-fund --no-audit \
      t3@0.0.40 vite-plus@0.3.0 pnpm@11.10.0 @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.270
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    download \
      https://downloads.cursor.com/lab/2026.09.10-fd3934a/linux/x64/agent-cli-package.tar.gz \
      "$temporary/cursor.tar.gz" \
      27997c8391ad853a5a732b1845db8ef82a8ba6afb0f7829cc739464f8966e96e
    destination="$HOME/.local/share/cursor-agent/versions/2026.09.10-fd3934a"
    mkdir -p "$destination"
    tar -xzf "$temporary/cursor.tar.gz" --strip-components=1 -C "$destination"
    ln -sfn "$destination/cursor-agent" "$HOME/.local/bin/agent"
    ln -sfn agent "$HOME/.local/bin/cursor-agent"
    ;;
  swift)
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    download \
      https://download.swift.org/swiftly/linux/swiftly-1.1.2-x86_64.tar.gz \
      "$temporary/swiftly.tar.gz" \
      21ad3d6376af0b423435f1f7295364add66c7173ea342654f4ae536c20ae88ba
    tar -xzf "$temporary/swiftly.tar.gz" -C "$temporary"
    "$temporary/swiftly" init --assume-yes --skip-install --quiet-shell-followup
    # --quiet-shell-followup can append a source of env.sh. (trailing period).
    # A missing path aborts login shells before later PATH setup can run.
    swiftly_env="$HOME/.local/share/swiftly/env.sh"
    for rc in "$HOME/.profile" "$HOME/.bashrc"; do
      test -f "$rc" || continue
      tmp=$(mktemp)
      awk -v env="$swiftly_env" -v exists="$(test -f "$swiftly_env" && echo 1 || echo 0)" '
        /(^|[[:space:]])(\.|source)[[:space:]].*env\.sh\./ {
          if (exists == "1") print ". \"" env "\""
          next
        }
        { print }
      ' "$rc" > "$tmp"
      cat "$tmp" > "$rc"
      rm -f "$tmp"
    done
    source "$HOME/.local/share/swiftly/env.sh"
    cd "$HOME"
    swiftly install --assume-yes --use --post-install-file "$temporary/swift-post-install.sh" 6.3.3
    if test -s "$temporary/swift-post-install.sh"; then
      sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
      sudo env DEBIAN_FRONTEND=noninteractive bash "$temporary/swift-post-install.sh"
    fi
    download \
      https://github.com/realm/SwiftLint/releases/download/0.65.1/swiftlint_linux_amd64.zip \
      "$temporary/swiftlint.zip" \
      caeed6f4a679c35539ffaf124f6c4ab4a8416917f7d8796279dc52b74026059d
    destination="$HOME/.cache/aura-swiftlint/0.65.1-Linux-x86_64"
    mkdir -p "$destination"
    unzip -q "$temporary/swiftlint.zip" swiftlint-static -d "$destination"
    chmod 755 "$destination/swiftlint-static"
    ln -sfn "$destination/swiftlint-static" "$HOME/.local/bin/swiftlint"
    ;;
  verify)
    for tool in node npm bun git gh rg python3 redis-server redis-cli go ruby t3 vp codex claude agent swift swiftlint; do
      command -v "$tool"
    done
    test "$(node --version)" = v24.21.0
    test "$(bun --version)" = 1.4.0
    codex --version
    claude --version
    agent --version
    t3 --version
    vp --version
    # The repository pins pnpm as its package manager, and corepack on this
    # image is too old to install it on Node 24.
    test "$(pnpm --version)" = 11.10.0
    swift --version
    swiftlint version
    temporary=$(mktemp -d)
    trap 'rm -rf "$temporary"' EXIT
    python3 -m venv "$temporary/venv"
    "$temporary/venv/bin/python" -c 'import ssl; print(ssl.OPENSSL_VERSION)'
    printf 'print("swift-ok")\n' > "$temporary/main.swift"
    swiftc "$temporary/main.swift" -o "$temporary/swift-proof"
    test "$("$temporary/swift-proof")" = swift-ok
    for path in .t3 .t3-cloud .codex/auth.json .claude/.credentials.json .cursor/auth.json .config/cursor/auth.json .config/gh/hosts.yml .git-credentials .env; do
      test ! -e "$HOME/$path"
    done
    test -z "$(find "$HOME" -name state.sqlite -o -name .git -o -name .env)"
    ;;
  *)
    printf 'Usage: %s system|runtimes|tools|swift|verify\n' "$0" >&2
    exit 2
    ;;
esac
