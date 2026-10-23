// @effect-diagnostics nodeBuiltinImport:off - ship state is packed into scratch files on this host.
/**
 * How a worktree on this host becomes the same worktree inside a copy booted from a base image:
 * what is shipped (a bundle of commits the base lacks, a tarball of everything that differs from
 * HEAD, a list of deletions), the script that applies it, how paths and the caller's environment
 * map into the copy, and which installs drifted from the base. These change together, so they live
 * together.
 *
 * @module worktreeForkShip
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { canonicalRepository } from "../environmentControl/config.ts";
import { MODAL_GUEST_ENV } from "../environmentControl/ModalRuntime.ts";
import { fileDigest } from "../environmentControl/ProvisionPreparation.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { Packed, Upload } from "./worktreeForkCache.ts";
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

/**
 * What a copy booted from the base commit `baseSha` needs to reproduce `checkout`, committed or
 * not: its key now, and its archive packed into `dir` once something asks for it.
 */
export const shipState = Effect.fn("WorktreeForks.shipState")(function* (
  checkout: Checkout,
  baseSha: string,
  dir: string,
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
  // HEAD and the base name the bundle; the rest is what delta.tgz and `deleted` hold.
  const stateKey = contentKey(
    ["state", baseSha, checkout.head, contained.code === 1, deleted],
    changed.map((path) => ({ name: path, path: NodePath.join(root, path) })),
  );
  const key = yield* stateKey;
  const pack = Effect.gen(function* () {
    yield* Effect.try({
      try: () => NodeFS.mkdirSync(dir, { recursive: true }),
      catch: (cause) => new CheckoutRefused({ reason: "unreadable", cause }),
    });
    const parts = ["delta.tgz", "deleted"];
    if (contained.code === 1) {
      yield* succeeded(root, "git", [
        "bundle",
        "create",
        "-q",
        NodePath.join(dir, "head.bundle"),
        "HEAD",
        `^${baseSha}`,
      ]);
      parts.unshift("head.bundle");
    }
    yield* Effect.try({
      try: () =>
        NodeFS.writeFileSync(
          NodePath.join(dir, "deleted"),
          deleted.map((path) => `${path}\0`).join(""),
        ),
      catch: (cause) => new CheckoutRefused({ reason: "unreadable", cause }),
    });
    // gzip, not zstd: the template image has no zstd. No AppleDouble files from a macOS host.
    const packed = yield* run(
      root,
      "tar",
      ["-czf", NodePath.join(dir, "delta.tgz"), "--null", "-T", "-"],
      { stdin: changed.map((path) => `${path}\0`).join(""), env: { COPYFILE_DISABLE: "1" } },
    );
    if (packed.code !== 0 && !onlyLiveFileWarnings(packed.stderr))
      return yield* new CheckoutRefused({
        reason: "unreadable",
        cause: new Error(`tar exited ${packed.code}: ${packed.stderr.slice(-2000)}`),
      });
    const archive = NodePath.join(dir, "state.tar");
    yield* succeeded(dir, "tar", ["-cf", archive, ...parts], { env: { COPYFILE_DISABLE: "1" } });
    const bytes = NodeFS.statSync(archive).size;
    if (bytes > MAX_SHIPMENT_BYTES) return yield* new CheckoutRefused({ reason: "too_large" });
    // A HEAD that moved since is bundled under another key, so this pack is not cached.
    const head = (yield* succeeded(root, "git", ["rev-parse", "HEAD"])).trim();
    return {
      archive,
      bytes,
      key: head === checkout.head ? yield* stateKey : `moved to ${head}`,
    } satisfies Packed;
  }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, yield* ProcessRunner.ProcessRunner));
  const committed = nulList(
    yield* succeeded(root, "git", ["diff", "--name-only", "-z", "--no-renames", baseSha, "HEAD"]),
  );
  return {
    checkout,
    // Once per shipment, so a batch's jobs share one pack.
    state: { key, pack: yield* Effect.cached(pack) },
    driftDirs: driftInstallDirs([...committed, ...changed, ...deleted], (lockDir) =>
      NodeFS.existsSync(NodePath.join(root, lockDir, "bun.lock")),
    ),
  } satisfies Shipment;
});

/**
 * Files whose content an earlier hash read, by path, while their inode, size, times and mode stay
 * as they were. A write changes ctime, which nothing can set back, so a hit is the same content;
 * a file changed in the last two seconds could change again within the same tick, so it is not kept.
 */
const digests = new Map<string, { readonly stat: string; readonly digest: string }>();
const MAX_DIGESTS = 50_000;
const RACY_MS = 2_000;

const digestOf = async (path: string, stat: NodeFS.BigIntStats, now: number) => {
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(
    ":",
  );
  const known = digests.get(path);
  if (known?.stat === signature) return known.digest;
  const digest = await fileDigest(path);
  if (now - Number(stat.ctimeMs) > RACY_MS) {
    digests.delete(path);
    digests.set(path, { stat: signature, digest });
    if (digests.size > MAX_DIGESTS) digests.delete(digests.keys().next().value!);
  }
  return digest;
};

/** Feeds `path`, named `name`, to `hash` as tar would pack it: modes, links and content. */
const hashTree = async (
  hash: NodeCrypto.Hash,
  name: string,
  path: string,
  now: number,
): Promise<void> => {
  const stat = NodeFS.lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stat === undefined) return void hash.update(`${name}\0missing\0`);
  const mode = (stat.mode & 0o7777n).toString(8);
  if (stat.isSymbolicLink())
    return void hash.update(`${name}\0link\0${NodeFS.readlinkSync(path)}\0`);
  if (stat.isFile())
    return void hash.update(`${name}\0file\0${mode}\0${await digestOf(path, stat, now)}\0`);
  if (!stat.isDirectory()) return void hash.update(`${name}\0other\0`);
  hash.update(`${name}\0dir\0${mode}\0`);
  for (const child of NodeFS.readdirSync(path).toSorted())
    await hashTree(hash, `${name}/${child}`, NodePath.join(path, child), now);
};

/**
 * The sha256 of `context` and each entry's tree, read from `path` and named `name`, the path it is
 * packed under. File times are left out: what a copy runs is the same without them.
 */
export const contentKey = Effect.fnUntraced(function* (
  context: ReadonlyArray<unknown>,
  entries: ReadonlyArray<{ readonly name: string; readonly path: string }>,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.tryPromise({
    try: async () => {
      const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(context));
      for (const entry of entries) await hashTree(hash, entry.name, entry.path, now);
      return hash.digest("hex");
    },
    catch: (cause) => new CheckoutRefused({ reason: "unreadable", cause }),
  });
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
 * packed into `dir` relative to `/` only when a copy needs it, for the copy to unpack at the same
 * paths (INPUTS_SCRIPT in WorktreeForks.ts).
 */
export const inputUploads = Effect.fn("WorktreeForks.inputUploads")(function* (
  paths: ReadonlyArray<string>,
  dir: string,
) {
  if (paths.some((path) => !NodeFS.existsSync(path)))
    return yield* new CheckoutRefused({ reason: "missing_input" });
  // tar packs a symlink as a link, which would dangle in the copy.
  if (paths.some((path) => NodeFS.lstatSync(path).isSymbolicLink()))
    return yield* new CheckoutRefused({ reason: "symlinked_input" });
  if (paths.reduce((sum, path) => sum + diskBytes(path), 0) > MAX_INPUT_BYTES)
    return yield* new CheckoutRefused({ reason: "inputs_too_large" });
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* Effect.forEach(paths, (path, index) =>
    Effect.gen(function* () {
      const inputKey = contentKey(["input"], [{ name: path, path }]);
      const pack = Effect.gen(function* () {
        const archive = NodePath.join(dir, `input-${index}.tgz`);
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
        return { archive, bytes, key: yield* inputKey } satisfies Packed;
      }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, runner));
      return { key: yield* inputKey, pack } satisfies Upload;
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
 * The caller's environment as a copy should see it. Host session variables go, and so does any
 * path under the host's home outside the worktree, since nothing else of the host exists in the
 * copy; for a colon list only those entries go. PATH keeps the caller's entries inside the
 * worktree (node_modules/.bin from `bun run`) ahead of the image's own. T3CODE_* goes too: a copy
 * is no T3 host, so wrappers there run their command where they are.
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
