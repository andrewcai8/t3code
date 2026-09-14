#!/bin/sh
# Install rg, redis-server, and redis-cli into $HOME/.local so they survive
# Namespace stop/resume. Homebrew lives outside /Volumes/devbox and is not retained.
set -eu

PREFIX="${PREFIX:-$HOME/.local}"
BIN="$PREFIX/bin"
mkdir -p "$BIN"

retained() {
  path=$(command -v "$1" 2>/dev/null || true)
  case "$path" in
    "$HOME"/*) return 0 ;;
  esac
  return 1
}

digest() {
  shasum -a 256 "$1" | awk '{print $1}'
}

fetch() {
  url=$1
  dest=$2
  expected=$3
  curl -fsSL --proto '=https' --tlsv1.2 --output "$dest" "$url"
  actual=$(digest "$dest")
  if [ "$actual" != "$expected" ]; then
    echo "SHA256 mismatch for $dest" >&2
    exit 1
  fi
}

self_contained() {
  output=$(otool -L "$1" 2>/dev/null) || return 1
  if printf '%s\n' "$output" | awk 'NR > 1' | grep -q /opt/homebrew; then
    return 1
  fi
  return 0
}

work="$HOME/.t3/tmp-retained-cli"
rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

if ! retained rg; then
  archive="$work/ripgrep.tar.gz"
  fetch \
    "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz" \
    "$archive" \
    "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"
  tar -xzf "$archive" -C "$work"
  install -m 755 "$work/ripgrep-15.2.0-aarch64-apple-darwin/rg" "$BIN/rg"
fi

if ! retained redis-server || ! retained redis-cli; then
  copied=0
  brew_redis=/opt/homebrew/opt/redis/bin
  if [ -x "$brew_redis/redis-server" ] && [ -x "$brew_redis/redis-cli" ] &&
    self_contained "$brew_redis/redis-server" &&
    self_contained "$brew_redis/redis-cli"; then
    cp "$brew_redis/redis-server" "$brew_redis/redis-cli" "$BIN/"
    chmod 755 "$BIN/redis-server" "$BIN/redis-cli"
    copied=1
  fi
  if [ "$copied" = 0 ]; then
    archive="$work/redis.tar.gz"
    fetch \
      "https://download.redis.io/releases/redis-7.4.11.tar.gz" \
      "$archive" \
      "3c266ece0abd54ed3b1c912c6eb86b7508cf382cb690ee6649d3843f018f6357"
    tar -xzf "$archive" -C "$work"
    (
      cd "$work"/redis-7.4.11
      make -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 2)" \
        PREFIX="$PREFIX" MALLOC=libc BUILD_TLS=no
      make PREFIX="$PREFIX" MALLOC=libc BUILD_TLS=no install
    )
  fi
fi

PATH="$BIN:$PATH"
export PATH
for tool in rg redis-server redis-cli; do
  path=$(command -v "$tool")
  case "$path" in
    "$BIN"/*) ;;
    *)
      echo "$tool is $path, expected under $BIN" >&2
      exit 1
      ;;
  esac
done
