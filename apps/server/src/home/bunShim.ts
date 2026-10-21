// @effect-diagnostics nodeBuiltinImport:off - the shim is a file beside the `t3` command ForkExec links.
/**
 * A `bun` in `~/.local/bin`, beside `t3`, that sends a plain whole-suite `bun test` from an agent
 * to `t3 fork-exec` on a host with worktree forks, and runs everything else, or anything it is
 * unsure of, with the real bun. A user's own `~/.local/bin/bun` is moved aside to
 * `.bun.t3-real` and put back when the shim is removed.
 *
 * @module bunShim
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { shellQuote } from "./forkExecProtocol.ts";

const MARKER = "# t3-bun-shim 1";
const REAL = ".bun.t3-real";
/** The T3 home whose server wrote the shim; only that server removes it. */
const ownerLine = (owner: string) => `# t3-home ${owner}`;

/**
 * Routes only when the first word is `test`, a T3 server advertises its socket (terminals strip
 * T3CODE_*, so this is an agent), no skip variable is set, and every other word is an existing
 * directory or a flag that writes nothing; a sandbox's writes never come back, so `-u` or
 * `--coverage` must run here. 75 means nothing started, so the real bun runs it; any other code,
 * 70 included, is the result.
 */
const script = (binDir: string, owner: string, skipWhenSet: ReadonlyArray<string>) => `#!/bin/sh
${MARKER}
${ownerLine(owner)}
# Written by T3 Code for worktree forks: sends a whole-suite \`bun test\` to \`t3 fork-exec\` and
# runs everything else with the real bun. T3 removes it, and restores any bun it moved aside to
# ${REAL}, when worktree forks or this shim are turned off.
shim=${shellQuote(NodePath.join(binDir, "bun"))}
real=${shellQuote(NodePath.join(binDir, REAL))}
t3=${shellQuote(NodePath.join(binDir, "t3"))}
skip_vars=${shellQuote(skipWhenSet.join(" "))}
if ! [ -x "$real" ]; then
  real=
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    if [ -n "$dir" ] && [ -f "$dir/bun" ] && [ -x "$dir/bun" ] && ! [ "$dir/bun" -ef "$shim" ]; then
      real=$dir/bun
      break
    fi
  done
  IFS=$old_ifs
  if [ -z "$real" ]; then
    echo "bun: T3's shim at $shim found no other bun on PATH" >&2
    exit 127
  fi
fi
routable() {
  [ "\${1-}" = test ] || return 1
  [ -n "\${T3CODE_HOME-}" ] && [ -S "$T3CODE_HOME/fork.sock" ] || return 1
  for name in $skip_vars; do
    eval "[ -z \\"\\\${$name-}\\" ]" || return 1
  done
  [ -x "$t3" ] || return 1
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --bail | --bail=* | --only | --todo | --concurrent | --randomize | --pass-with-no-tests) ;;
      --timeout=* | --rerun-each=* | --max-concurrency=* | --seed=* | --shard=* | --test-name-pattern=*) ;;
      --timeout | --rerun-each | --max-concurrency | --seed | --shard | --test-name-pattern | -t)
        [ $# -ge 2 ] || return 1
        shift
        ;;
      -*) return 1 ;;
      *) [ -d "$1" ] || return 1 ;;
    esac
    shift
  done
}
if routable "$@"; then
  "$t3" fork-exec -- bun "$@"
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
fi
exec "$real" "$@"
`;

export type BunShimChange = "installed" | "moved_aside" | "conflict" | "removed" | "restored";

/** What `path` is to the T3 home `owner`: missing, its shim, another T3 home's shim, or not a shim. */
const observe = (path: string, owner: string) => {
  try {
    NodeFS.lstatSync(path);
  } catch {
    return "absent" as const;
  }
  try {
    const [, marker, home] = NodeFS.readFileSync(path, "utf8").split("\n", 3);
    if (marker !== MARKER) return "foreign" as const;
    return home === ownerLine(owner) ? ("ours" as const) : ("another home's" as const);
  } catch {
    return "foreign" as const;
  }
};

/**
 * Makes `binDir/bun` the shim of the T3 home `owner` (`want` set) or not (null), from what is on
 * disk now. Each step leaves a state the next run recognizes, so a crash between two renames is
 * repaired at the next start. A foreign `bun` with a `.bun.t3-real` already beside it is ambiguous
 * and left alone, and so is a shim another T3 home installed: a dev server on the same machine
 * must not remove the shim of the server that uses it.
 */
export const reconcileBunShim = (
  binDir: string,
  owner: string,
  want: { readonly skipWhenSet: ReadonlyArray<string> } | null,
): ReadonlyArray<BunShimChange> => {
  const bun = NodePath.join(binDir, "bun");
  const real = NodePath.join(binDir, REAL);
  const current = observe(bun, owner);
  const hasReal = observe(real, owner) !== "absent";
  const changes: Array<BunShimChange> = [];
  if (want === null) {
    if (current === "ours") {
      NodeFS.rmSync(bun);
      changes.push("removed");
    }
    if ((current === "ours" || current === "absent") && hasReal) {
      NodeFS.renameSync(real, bun);
      changes.push("restored");
    }
    return changes;
  }
  if (current === "foreign") {
    if (hasReal) return ["conflict"];
    NodeFS.renameSync(bun, real);
    changes.push("moved_aside");
  }
  NodeFS.mkdirSync(binDir, { recursive: true });
  const staged = NodePath.join(binDir, `.bun.t3-staged.${process.pid}`);
  NodeFS.writeFileSync(staged, script(binDir, owner, want.skipWhenSet), { mode: 0o755 });
  NodeFS.renameSync(staged, bun);
  changes.push("installed");
  return changes;
};
