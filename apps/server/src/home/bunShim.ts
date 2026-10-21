// @effect-diagnostics nodeBuiltinImport:off - the shim is a file beside the `t3` command ForkExec links.
/**
 * A `bun` in `~/.local/bin`, beside `t3`, that sends a plain, large `bun test` from an agent
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

export interface BunShimSettings {
  readonly skipWhenSet: ReadonlyArray<string>;
  readonly minTestFiles: number;
}

/**
 * Routes only when the first word is `test`, a T3 server advertises its socket (terminals strip
 * T3CODE_*, so this is an agent), no skip variable is set, and every other word is an existing
 * directory or a flag that writes nothing; a sandbox's writes never come back, so `-u` or
 * `--coverage` must run here. A run named by directories routes only when they hold at least
 * `minTestFiles` test files, since a copy takes about ten seconds to start. Counting stops there,
 * and a directory find cannot read counts short, so that run stays here. 75 means nothing
 * started, so the real bun runs it; any other code, 70 included, is the result.
 */
const script = (binDir: string, owner: string, settings: BunShimSettings) => `#!/bin/sh
${MARKER}
${ownerLine(owner)}
# Written by T3 Code for worktree forks: sends a large \`bun test\` run to \`t3 fork-exec\` and
# runs everything else with the real bun. T3 removes it, and restores any bun it moved aside to
# ${REAL}, when worktree forks or this shim are turned off.
shim=${shellQuote(NodePath.join(binDir, "bun"))}
real=${shellQuote(NodePath.join(binDir, REAL))}
t3=${shellQuote(NodePath.join(binDir, "t3"))}
skip_vars=${shellQuote(settings.skipWhenSet.join(" "))}
min_test_files=${settings.minTestFiles}
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
# Bun's default test file names, outside node_modules and dot directories.
test_files() {
  case $1 in /*) start=$1 ;; *) start=./$1 ;; esac
  find "$start" -type d \\( -name node_modules -o -name '.?*' \\) -prune -o -type f \\( \\
    -name '*[._]test.[jt]s' -o -name '*[._]test.[jt]sx' -o -name '*[._]test.[cm]js' -o \\
    -name '*[._]spec.[jt]s' -o -name '*[._]spec.[jt]sx' -o -name '*[._]spec.[cm]js' \\) \\
    -print 2>/dev/null | head -n "$2" | wc -l
}
routable() {
  [ "\${1-}" = test ] || return 1
  [ -n "\${T3CODE_HOME-}" ] && [ -S "$T3CODE_HOME/fork.sock" ] || return 1
  for name in $skip_vars; do
    eval "[ -z \\"\\\${$name-}\\" ]" || return 1
  done
  [ -x "$t3" ] || return 1
  shift
  dirs=0
  found=0
  while [ $# -gt 0 ]; do
    case $1 in
      --bail | --bail=* | --only | --todo | --concurrent | --randomize | --pass-with-no-tests) ;;
      --isolate | --no-isolate | --parallel | --dots | --reporter=dots | --only-failures | --no-orphans) ;;
      --timeout=* | --rerun-each=* | --max-concurrency=* | --seed=* | --shard=* | --test-name-pattern=*) ;;
      --retry=* | --parallel=* | --parallel-delay=* | --path-ignore-patterns=*) ;;
      --timeout | --rerun-each | --max-concurrency | --seed | --shard | --test-name-pattern | -t | \
        --retry | --parallel-delay | --path-ignore-patterns)
        [ $# -ge 2 ] || return 1
        shift
        ;;
      -*) return 1 ;;
      *)
        [ -d "$1" ] || return 1
        dirs=1
        if [ "$found" -lt "$min_test_files" ]; then
          found=$((found + $(test_files "$1" $((min_test_files - found)))))
        fi
        ;;
    esac
    shift
  done
  [ "$dirs" -eq 0 ] || [ "$found" -ge "$min_test_files" ]
}
if routable "$@"; then
  T3CODE_FORK_CALLER=bun-shim "$t3" fork-exec -- bun "$@"
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
  want: BunShimSettings | null,
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
  NodeFS.writeFileSync(staged, script(binDir, owner, want), { mode: 0o755 });
  NodeFS.renameSync(staged, bun);
  changes.push("installed");
  return changes;
};
