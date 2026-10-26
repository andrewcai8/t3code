// @effect-diagnostics nodeBuiltinImport:off - ship state is packed into scratch files on this host.
/**
 * How a worktree on this host becomes the same worktree inside a copy booted from a base image: the
 * commits bundle, tarball of differences from HEAD and list of deletions, the script that applies
 * them, how paths and environment map into the copy, and which installs drifted from the base.
 *
 * @module worktreeForkShip
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { canonicalRepository } from "../environmentControl/config.ts";
import { MODAL_GUEST_ENV } from "../environmentControl/ModalRuntime.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { Packed, Upload } from "./worktreeForkCache.ts";
import { archiveKey, contentKey } from "./worktreeForkContent.ts";
import type { ForkRepository } from "./worktreeForksConfig.ts";

/** A shipment past this is not a worktree's state but something that belongs in .gitignore. */
const MAX_SHIPMENT_BYTES = 256 * 1024 * 1024;
/** Checked before inputs are packed, so an oversized one never costs this host a full gzip. */
const MAX_INPUT_BYTES = 1024 * 1024 * 1024;

const REFUSALS = {
  not_a_repository: "The command's directory is not inside a git checkout.",
  unconfigured_repository:
    "This checkout's origin is not a repository listed in worktree-forks.json.",
  missing_base_commit:
    "This checkout lacks the commit its copy starts from; fetch origin and run it again.",
  too_large: "This worktree's uncommitted state is over 256 MiB, too much to copy.",
  unreadable: "This worktree's state could not be read.",
  missing_input: "A path given as an input does not exist on this host.",
  symlinked_input: "An input is a symlink; name the file or directory it points to.",
  inputs_too_large: "The command's inputs are over 1 GiB, or 256 MiB compressed, too much to copy.",
} as const;

export class CheckoutRefused extends Schema.TaggedError<CheckoutRefused>()("CheckoutRefused", {
  reason: Schema.Literals([
    "not_a_repository",
    "unconfigured_repository",
    "missing_base_commit",
    "too_large",
    "unreadable",
    "missing_input",
    "symlinked_input",
    "inputs_too_large",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return REFUSALS[this.reason];
  }
}

/** A git checkout on this host that a configured repository's bases can copy. */
export interface Checkout {
  /** `git rev-parse --show-toplevel`; the copy mounts its checkout at this same path. */
  readonly root: string;
  /** The command's directory, under `root`. */
  readonly cwd: string;
  readonly repository: ForkRepository;
  readonly head: string;
  /** The checked-out branch, null when detached. */
  readonly branch: string | null;
}

/** A checkout's state packed against one base, on this host until its job or batch ends. */
export interface Shipment {
  readonly checkout: Checkout;
  /**
   * One tar holding `head.bundle` (when HEAD is not in the base), `delta.tgz` and `deleted`, keyed
   * by what it holds and packed at most once, only when a copy needs it and the cache lacks it.
   */
  readonly state: Upload;
  /** Directories whose installs drifted from the base, relative to the root. */
  readonly driftDirs: ReadonlyArray<string>;
}

// Each git call is a step of the operation that runs it, which already has a span.
const run = Effect.fnUntraced(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const result = yield* (yield* ProcessRunner.ProcessRunner)
    .run({ command, args, cwd, timeout: "5 minutes", maxOutputBytes: 64 * 1024 * 1024, ...options })
    .pipe(Effect.mapError((cause) => new CheckoutRefused({ reason: "unreadable", cause })));
  return { code: Number(result.code), stdout: result.stdout, stderr: result.stderr };
});

const succeeded = Effect.fnUntraced(function* (
  cwd: string,
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv },
) {
  const result = yield* run(cwd, command, args, options);
  if (result.code !== 0)
    return yield* new CheckoutRefused({
      reason: "unreadable",
      cause: new Error(
        `${command} ${args[0]} exited ${result.code}: ${result.stderr.slice(-2000)}`,
      ),
    });
  return result.stdout;
});

const nulList = (text: string) => text.split("\0").filter((path) => path !== "");

/** The configured repository an origin URL names, or null: https, ssh or scp-like GitHub URLs. */
const originRepository = (url: string) => {
  try {
    return canonicalRepository(
      url
        .trim()
        .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/i, "")
        .replace(/^https?:\/\/[^@/]+@github\.com\//i, ""),
    );
  } catch {
    return null;
  }
};

export const inspectCheckout = Effect.fn("WorktreeForks.inspectCheckout")(function* (
  cwd: string,
  repositories: ReadonlyMap<string, ForkRepository>,
) {
  const top = yield* run(cwd, "git", ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (top.code !== 0) return yield* new CheckoutRefused({ reason: "not_a_repository" });
  const [root = "", prefix = ""] = top.stdout.split("\n");
  // The URL as written: `remote get-url` applies insteadOf rewrites, which can hide GitHub.
  const origin = yield* run(root, "git", ["config", "--get", "remote.origin.url"]);
  const repository = repositories.get(
    (origin.code === 0 ? originRepository(origin.stdout) : null) ?? "",
  );
  if (repository === undefined)
    return yield* new CheckoutRefused({ reason: "unconfigured_repository" });
  const head = (yield* succeeded(root, "git", ["rev-parse", "HEAD"])).trim();
  const branch = yield* run(root, "git", ["symbolic-ref", "--short", "-q", "HEAD"]);
  return {
    root,
    cwd: NodePath.join(root, prefix.replace(/\/$/, "")),
    repository,
    head,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
  } satisfies Checkout;
});

/**
 * Whether GNU tar failed only because files changed or vanished while it read them. Agents keep
 * writing in their worktree (a test's sqlite file, a temp dir), and tar still packs what it read,
 * which is the state the copy gets; any other complaint means the pack is not to be trusted.
 */
export const onlyLiveFileWarnings = (stderr: string) => {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  return (
    lines.length > 0 &&
    lines.every((line) =>
      /: file changed as we read it$|: File removed before we read it$|: Cannot stat: No such file or directory$|^tar: Exiting with failure status due to previous errors$/.test(
        line,
      ),
    )
  );
};

/** The nearest directory at or above each changed manifest or lockfile that has a bun.lock. */
export const driftInstallDirs = (
  changed: ReadonlyArray<string>,
  hasLock: (dir: string) => boolean,
): ReadonlyArray<string> => {
  const dirs = new Set<string>();
  for (const path of changed) {
    if (!["package.json", "bun.lock"].includes(NodePath.posix.basename(path))) continue;
    for (let dir = NodePath.posix.dirname(path); ; dir = NodePath.posix.dirname(dir)) {
      if (hasLock(dir)) {
        dirs.add(dir);
        break;
      }
      if (dir === ".") break;
    }
  }
  return [...dirs].toSorted();
};

/** A hash failure is the worktree being unreadable, as a failed pack is. */
const unreadable = (cause: unknown) => new CheckoutRefused({ reason: "unreadable", cause });

/**
 * What a copy booted from the base commit `baseSha` needs to reproduce `checkout`, committed or
 * not: the key of that state now, and how to pack it into a directory.
 */
export const shipState = Effect.fn("WorktreeForks.shipState")(function* (
  checkout: Checkout,
  baseSha: string,
) {
  const { root } = checkout;
  if ((yield* run(root, "git", ["cat-file", "-e", `${baseSha}^{commit}`])).code !== 0)
    return yield* new CheckoutRefused({ reason: "missing_base_commit" });
  const contained = yield* run(root, "git", ["merge-base", "--is-ancestor", "HEAD", baseSha]);
  if (contained.code > 1)
    return yield* new CheckoutRefused({
      reason: "unreadable",
      cause: new Error(contained.stderr.slice(-2000)),
    });
  const bundled = contained.code === 1;
  const changed = [
    ...nulList(
      yield* succeeded(root, "git", [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-filter=d",
        "HEAD",
      ]),
    ),
    ...nulList(yield* succeeded(root, "git", ["ls-files", "-o", "--exclude-standard", "-z"])),
    ...checkout.repository.ship.filter((path) => NodeFS.existsSync(NodePath.join(root, path))),
  ];
  const deleted = nulList(
    yield* succeeded(root, "git", [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=D",
      "HEAD",
    ]),
  );
  // The bundle is named by the commits it brings; delta.tgz and `deleted` by what they hold.
  const context = (head: string) => ["state", baseSha, head, bundled ? "bundle" : "", ...deleted];
  const key = yield* contentKey(
    context(checkout.head),
    changed.map((path) => ({ name: path, path: NodePath.join(root, path) })),
  ).pipe(Effect.mapError(unreadable));
  const runner = yield* ProcessRunner.ProcessRunner;
  const pack = Effect.fn("WorktreeForks.packState")(
    function* (dir: string) {
      yield* Effect.try({
        try: () => NodeFS.mkdirSync(dir, { recursive: true }),
        catch: unreadable,
      });
      const parts = ["delta.tgz", "deleted"];
      let head = checkout.head;
      if (bundled) {
        const bundle = NodePath.join(dir, "head.bundle");
        yield* succeeded(root, "git", ["bundle", "create", "-q", bundle, "HEAD", `^${baseSha}`]);
        // The commit the bundle holds, which a HEAD that moved since the job was sent changed.
        head = (yield* succeeded(root, "git", ["bundle", "list-heads", bundle])).split(" ")[0]!;
        parts.unshift("head.bundle");
      }
      yield* Effect.try({
        try: () =>
          NodeFS.writeFileSync(
            NodePath.join(dir, "deleted"),
            deleted.map((path) => `${path}\0`).join(""),
          ),
        catch: unreadable,
      });
      const delta = NodePath.join(dir, "delta.tgz");
      // gzip, not zstd: the template image has no zstd. No AppleDouble files from a macOS host.
      const packed = yield* run(root, "tar", ["-czf", delta, "--null", "-T", "-"], {
        stdin: changed.map((path) => `${path}\0`).join(""),
        env: { COPYFILE_DISABLE: "1" },
      });
      if (packed.code !== 0 && !onlyLiveFileWarnings(packed.stderr))
        return yield* new CheckoutRefused({
          reason: "unreadable",
          cause: new Error(`tar exited ${packed.code}: ${packed.stderr.slice(-2000)}`),
        });
      const archive = NodePath.join(dir, "state.tar");
      yield* succeeded(dir, "tar", ["-cf", archive, ...parts], {
        env: { COPYFILE_DISABLE: "1" },
      });
      const bytes = NodeFS.statSync(archive).size;
      if (bytes > MAX_SHIPMENT_BYTES) return yield* new CheckoutRefused({ reason: "too_large" });
      return {
        archive,
        bytes,
        key: yield* archiveKey(context(head), delta).pipe(Effect.mapError(unreadable)),
      } satisfies Packed;
    },
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const committed = nulList(
    yield* succeeded(root, "git", ["diff", "--name-only", "-z", "--no-renames", baseSha, "HEAD"]),
  );
  return {
    checkout,
    state: { key, pack },
    driftDirs: driftInstallDirs([...committed, ...changed, ...deleted], (lockDir) =>
      NodeFS.existsSync(NodePath.join(root, lockDir, "bun.lock")),
    ),
  } satisfies Shipment;
});

/** Bytes of the files under `path`, not following symlinks. */
const diskBytes = (path: string): number => {
  const stat = NodeFS.lstatSync(path);
  return stat.isDirectory()
    ? NodeFS.readdirSync(path).reduce((sum, name) => sum + diskBytes(NodePath.join(path, name)), 0)
    : stat.size;
};

/**
 * Host paths the command reads beyond its worktree, one archive each, keyed by what it holds and
 * packed relative to `/` into a directory when a copy needs it, for the copy to unpack at the same
 * paths (INPUTS_SCRIPT in WorktreeForks.ts).
 */
export const inputUploads = Effect.fn("WorktreeForks.inputUploads")(function* (
  paths: ReadonlyArray<string>,
) {
  if (paths.some((path) => !NodeFS.existsSync(path)))
    return yield* new CheckoutRefused({ reason: "missing_input" });
  // tar packs a symlink as a link, which would dangle in the copy.
  if (paths.some((path) => NodeFS.lstatSync(path).isSymbolicLink()))
    return yield* new CheckoutRefused({ reason: "symlinked_input" });
  if (paths.reduce((sum, path) => sum + diskBytes(path), 0) > MAX_INPUT_BYTES)
    return yield* new CheckoutRefused({ reason: "inputs_too_large" });
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* Effect.forEach(paths, (path) =>
    Effect.gen(function* () {
      const pack = Effect.fn("WorktreeForks.packInput")(
        function* (dir: string) {
          yield* Effect.try({
            try: () => NodeFS.mkdirSync(dir, { recursive: true }),
            catch: unreadable,
          });
          const archive = NodePath.join(dir, "input.tgz");
          const packed = yield* run("/", "tar", ["-czf", archive, "--null", "-T", "-"], {
            stdin: `${path.slice(1)}\0`,
            env: { COPYFILE_DISABLE: "1" },
          });
          if (packed.code !== 0 && !onlyLiveFileWarnings(packed.stderr))
            return yield* new CheckoutRefused({
              reason: "unreadable",
              cause: new Error(`tar exited ${packed.code}: ${packed.stderr.slice(-2000)}`),
            });
          const bytes = NodeFS.statSync(archive).size;
          if (bytes > MAX_SHIPMENT_BYTES)
            return yield* new CheckoutRefused({ reason: "inputs_too_large" });
          const key = yield* archiveKey(["input"], archive, (name) => `/${name}`).pipe(
            Effect.mapError(unreadable),
          );
          return { archive, bytes, key } satisfies Packed;
        },
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      const key = yield* contentKey(["input"], [{ name: path, path }]).pipe(
        Effect.mapError(unreadable),
      );
      return { key, pack } satisfies Upload;
    }),
  );
});

/** Whether inputs placed in a copy are past the compressed cap, as one archive of them was. */
export const inputsTooLarge = (bytes: ReadonlyArray<number>) =>
  bytes.reduce((sum, size) => sum + size, 0) > MAX_SHIPMENT_BYTES
    ? new CheckoutRefused({ reason: "inputs_too_large" })
    : null;

/**
 * Applies a shipment in a copy's checkout, which sits at the base's commit:
 * $1 the uploaded archive, $2 the checkout, $3 HEAD, $4 the branch or "", then the drift
 * directories. Mounting the checkout at the worktree's own path is a separate step.
 */
const APPLY_SCRIPT = `set -eu
archive=$1; stage=$(mktemp -d); cd "$2"; head=$3; branch=$4; shift 4
mkdir -p "$stage" && tar -xf "$archive" -C "$stage"
if [ -f "$stage/head.bundle" ]; then git fetch -q "$stage/head.bundle" "+HEAD:refs/t3/job"; fi
git checkout -qf --detach "$head"
if [ -n "$branch" ]; then git checkout -q -B "$branch"; fi
gzip -dc "$stage/delta.tgz" | tar -x
xargs -0 rm -f -- < "$stage/deleted"
for dir in "$@"; do (cd "$dir" && bun install --frozen-lockfile); done
`;

export const applyArgv = (shipment: Shipment, archive: string): ReadonlyArray<string> => [
  "sh",
  "-c",
  APPLY_SCRIPT,
  "t3-apply",
  archive,
  shipment.checkout.repository.workDir,
  shipment.checkout.head,
  shipment.checkout.branch ?? "",
  ...shipment.driftDirs,
];

/** Variables that describe the host's session, not the command. */
const HOST_ONLY = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMPDIR",
  "TMP",
  "TEMP",
  "MAIL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
]);
const HOST_ONLY_PREFIXES = ["XDG_", "DBUS_", "T3CODE_", "TERM_PROGRAM"];
const GUEST_PATH =
  "/home/user/.bun/bin:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const GUEST_IDENTITY = Object.fromEntries(
  MODAL_GUEST_ENV.slice(1).map((entry) => entry.split("=") as [string, string]),
);

/**
 * The caller's environment as a copy should see it. Host session variables go, as does any path
 * under the host's home outside the worktree. PATH keeps the caller's entries inside the worktree
 * ahead of the image's own. T3CODE_* goes too: a copy is no T3 host, so wrappers there run their
 * command where they are.
 */
export const sandboxEnvironment = (
  caller: Readonly<Record<string, string>>,
  root: string,
  hostHome: string,
): Readonly<Record<string, string>> => {
  const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);
  const hostOnly = (segment: string) =>
    hostHome.length > 1 && inside(segment, hostHome) && !inside(segment, root);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(caller)) {
    if (
      name === "PATH" ||
      HOST_ONLY.has(name) ||
      HOST_ONLY_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
      continue;
    const segments = value.split(":");
    const kept = segments.filter((segment) => !hostOnly(segment));
    if (kept.length === segments.length) environment[name] = value;
    else if (kept.some((segment) => segment !== "")) environment[name] = kept.join(":");
  }
  const worktreePath = (caller.PATH ?? "").split(":").filter((segment) => inside(segment, root));
  return { ...environment, PATH: [...worktreePath, GUEST_PATH].join(":"), ...GUEST_IDENTITY };
};
