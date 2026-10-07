// @effect-diagnostics nodeBuiltinImport:off - pure helpers for the move-chat CLI, which runs git and resolves local paths.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import type { BackupManifest } from "../../apps/server/src/environmentControl/boxBackup.ts";

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

const PATH_PATTERN = /(?<![\w.~$/-])(?:~|\$HOME|\$\{HOME\})?\/[\w.@%+~-]+(?:\/[\w.@%+~-]*)*/g;

/**
 * The paths outside `cwd` an agent's tool calls named or their output printed, from a session's
 * transcripts (main and subagents, JSONL) and its persisted tool outputs (plain text). Only paths
 * under `home` or `/tmp` count; Claude's own `/tmp/claude-<uid>` scratch does not. Anything in a
 * dot-directory of `home` or in `~/Library` is tool config, reported once as that directory.
 * Sorted, so a parent precedes its children.
 */
export function referencedPaths(
  input: { readonly transcripts: ReadonlyArray<string>; readonly outputs: ReadonlyArray<string> },
  scope: { readonly home: string; readonly cwd: string },
): { readonly paths: ReadonlyArray<string>; readonly toolConfig: ReadonlyArray<string> } {
  const paths = new Set<string>();
  const toolConfig = new Set<string>();
  const scan = (text: string) => {
    for (const [match] of text.matchAll(PATH_PATTERN)) {
      const path = NodePath.posix
        .normalize(
          match
            .replace(/^(?:~|\$HOME|\$\{HOME\})\//, `${scope.home}/`)
            .replace(/^\/private\/tmp\//, "/tmp/"),
        )
        .replace(/[./]+$/, "");
      const under = (root: string) => path.startsWith(`${root}/`);
      if (path === scope.cwd || under(scope.cwd) || /^\/tmp\/claude-\d+(\/|$)/.test(path)) continue;
      if (under(scope.home)) {
        const top = path.slice(scope.home.length + 1).split("/")[0]!;
        if (top.startsWith(".") || top === "Library") toolConfig.add(`${scope.home}/${top}`);
        else paths.add(path);
      } else if (under("/tmp")) paths.add(path);
    }
  };
  const scanValue = (value: unknown): void => {
    if (typeof value === "string") scan(value);
    else if (value && typeof value === "object") Object.values(value).forEach(scanValue);
  };
  for (const transcript of input.transcripts)
    for (const line of transcript.split("\n")) {
      if (!line.includes('"tool_')) continue;
      const content = parseRecord(line)?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ReadonlyArray<{
        type?: string;
        input?: unknown;
        content?: unknown;
      }>)
        if (block.type === "tool_use") scanValue(block.input);
        else if (block.type === "tool_result") scanValue(block.content);
    }
  input.outputs.forEach(scan);
  return { paths: [...paths].toSorted(), toolConfig: [...toolConfig].toSorted() };
}

// A live session's last line can be half written.
function parseRecord(line: string): { message?: { content?: unknown } } | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** What a path is on disk, measured until it is known to be too big to carry. */
export type CarryProbe =
  | { readonly kind: "missing" }
  | { readonly kind: "repo"; readonly root: string; readonly remote: string | null }
  | { readonly kind: "tree"; readonly bytes: number; readonly holdsRepo: boolean };

export interface CarryPlan {
  readonly carry: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/**
 * Picks which referenced paths to copy. A path covers its children; one too big to carry whole, or
 * holding a git repo, falls back to the referenced paths inside it. Smallest first within the
 * total cap, so one huge item never crowds out the notes.
 */
export function planCarry(
  paths: ReadonlyArray<string>,
  probe: (path: string) => CarryProbe,
  caps: { readonly itemBytes: number; readonly totalBytes: number },
): CarryPlan {
  const covered: Array<string> = [];
  const candidates: Array<{ path: string; bytes: number }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const isCovered = (path: string) =>
    covered.some((root) => path === root || path.startsWith(`${root}/`));
  for (const path of paths) {
    if (isCovered(path)) continue;
    const found = probe(path);
    if (found.kind === "missing") covered.push(path);
    else if (found.kind === "repo") {
      covered.push(found.root);
      skipped.push({
        path: found.root,
        reason: `git repo (code is on GitHub/clone again)${found.remote ? `: ${found.remote}` : ""}`,
      });
    } else if (found.holdsRepo) skipped.push({ path, reason: "holds a git repo" });
    else if (found.bytes > caps.itemBytes)
      skipped.push({ path, reason: `over the ${formatBytes(caps.itemBytes)} item cap` });
    else {
      covered.push(path);
      candidates.push({ path, bytes: found.bytes });
    }
  }
  const fits = new Set<string>();
  let total = 0;
  for (const candidate of candidates.toSorted((a, b) => a.bytes - b.bytes)) {
    if (total + candidate.bytes > caps.totalBytes)
      skipped.push({
        path: candidate.path,
        reason: `over the ${formatBytes(caps.totalBytes)} total cap`,
      });
    else {
      total += candidate.bytes;
      fits.add(candidate.path);
    }
  }
  return { carry: candidates.filter((candidate) => fits.has(candidate.path)), skipped };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export interface RestorePlan {
  readonly repository: string;
  readonly branch: string;
  readonly sessionId: string;
  /** The session's transcript, as a key under the backup's prefix. */
  readonly transcript: string;
  readonly title: string;
  /** The first message on the new box, telling the agent what came back and what did not. */
  readonly message: string;
}

/**
 * How a chat comes back on a fresh box from the backup its old box took before sleeping: on the
 * backup branch of its main checkout when the old box had unsaved work there, otherwise on the
 * branch it had checked out, with its latest Claude session. Throws when the backup cannot make
 * the chat whole: no GitHub repository, no branch, or no Claude session.
 */
export function planRestore(manifest: BackupManifest, uri: string): RestorePlan {
  const repository = manifest.repository && githubRepository(manifest.repository);
  if (!repository)
    throw new Error(`the backup names no GitHub repository (${manifest.repository})`);
  const mainBackup = `t3-backup/${manifest.leaseId}`;
  const branch = manifest.backupBranches.includes(mainBackup) ? mainBackup : manifest.branch;
  if (!branch)
    throw new Error("the backup has no branch: its checkout was detached and saved nothing");
  const restorable = manifest.sessions
    .filter((candidate) => candidate.driver === "claudeAgent")
    .flatMap((candidate) => {
      const transcript = candidate.files.find((file) =>
        file.endsWith(`/${candidate.nativeId}.jsonl`),
      );
      return transcript ? [{ sessionId: candidate.nativeId, transcript }] : [];
    })
    .at(-1);
  if (!restorable) {
    const others = manifest.sessions.map((candidate) => candidate.driver).join(", ");
    throw new Error(
      `the backup holds no Claude session to restore${others ? ` (only ${others}, under ${uri})` : ""}`,
    );
  }
  const otherBranches = manifest.backupBranches.filter((name) => name !== branch);
  const title = manifest.title ?? `Restored ${manifest.environmentId}`;
  return {
    repository,
    branch,
    ...restorable,
    title,
    message: [
      `This chat was restored on a fresh machine from the backup its old machine (environment ${manifest.environmentId}) took before it slept; that machine could not be resumed.`,
      branch === mainBackup
        ? `The checkout is ${branch}: the old machine's ${manifest.branch ?? "checkout"} with its unpushed commits, plus any uncommitted changes as one commit titled "T3 backup of unsaved work". Move that work back onto your own branch before you push.`
        : `The checkout is ${branch}; the old machine had no unpushed work in it.`,
      ...(otherBranches.length > 0
        ? [`Other unsaved work is on: ${otherBranches.join(", ")}.`]
        : []),
      "Files outside the checkout, running processes and anything else on the old machine did not come back. Check `git status` and `git log -3`, then carry on where you left off.",
    ].join("\n\n"),
  };
}
