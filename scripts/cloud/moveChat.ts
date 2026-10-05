import * as NodeChildProcess from "node:child_process";

/**
 * The directory Claude Code keeps a working directory's sessions in, under `<config>/projects`:
 * the absolute path with every character outside `[A-Za-z0-9]` replaced by `-`. Claude shortens
 * longer names with a hash this does not reproduce, so they are refused.
 */
export function claudeProjectDirName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length > 200) throw new Error(`${cwd} is too long for a Claude project directory`);
  return name;
}

export function claudeSessionPath(input: {
  readonly configDir: string;
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  return `${input.configDir}/projects/${claudeProjectDirName(input.cwd)}/${input.sessionId}.jsonl`;
}

/**
 * Moves a Claude session transcript to another checkout: every record's `cwd` under `from` is
 * rebased onto `to`. Message text keeps the old paths; the agent is told its paths changed.
 */
export function rewriteSessionCwd(contents: string, from: string, to: string): string {
  const quoted = (path: string) => JSON.stringify(path).slice(1, -1);
  const pattern = new RegExp(`"cwd":"${escapeRegExp(quoted(from))}(?=["/])`, "g");
  return contents.replace(pattern, () => `"cwd":"${quoted(to)}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Prints the commit that holds a checkout exactly as it is on disk: HEAD plus every tracked
 * change and untracked file git does not ignore. It stages into a throwaway index, so the
 * checkout, its index and its branch are untouched. A clean checkout answers HEAD itself.
 * Runs with `sh` both on this Mac and on a box, so the two directions snapshot alike.
 */
export const SNAPSHOT_SCRIPT = `set -e
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
index="$scratch/index"
GIT_INDEX_FILE="$index" git read-tree HEAD
GIT_INDEX_FILE="$index" git add -A
tree=$(GIT_INDEX_FILE="$index" git write-tree)
if [ "$tree" = "$(git rev-parse 'HEAD^{tree}')" ]; then
  git rev-parse HEAD
else
  git commit-tree "$tree" -p HEAD -m "$MOVE_CHAT_MESSAGE"
fi`;

export function snapshotCheckout(cwd: string, message: string): string {
  return NodeChildProcess.execFileSync("sh", ["-c", SNAPSHOT_SCRIPT], {
    cwd,
    env: { ...process.env, MOVE_CHAT_MESSAGE: message },
    encoding: "utf8",
  }).trim();
}

/** `owner/name` of a GitHub remote URL, or null for any other host. */
export function githubRepository(remoteUrl: string): string | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}
