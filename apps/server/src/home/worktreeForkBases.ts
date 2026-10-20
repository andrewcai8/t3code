// @effect-diagnostics nodeBuiltinImport:off - base records and build archives are small files on this host.
/**
 * The images a repository's copies boot from. A base is the repository's default branch with its
 * prepare commands already run, so a copy only applies the worktree's own changes. This host owns
 * its bases: it builds the first one on demand from a git bundle of its own fetch (a copy needs
 * no git credential), refreshes it in the background at most hourly once origin moves, keeps two,
 * and lets Modal expire the rest.
 *
 * @module worktreeForkBases
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  COPY_PURPOSE,
  copySpec,
  type ForkRepository,
  type ForkSandboxes,
  type WorktreeForksHost,
} from "./worktreeForksConfig.ts";
import { type Checkout, sandboxEnvironment } from "./worktreeForkShip.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Modal deletes a base this long after it was taken, whatever becomes of this host. */
const IMAGE_TTL_MS = 14 * DAY;
/** A copy never boots from an image that might expire while it starts. */
const USABLE_MS = 13 * DAY;
const CHECK_EVERY_MS = HOUR;
/** Rebuilt at the same commit after this, so a repository whose origin is quiet keeps a base. */
const RENEW_AFTER_MS = 7 * DAY;
const FAILURE_BACKOFF_MS = HOUR;
const KEEP = 2;
const PREPARE_TIMEOUT_MS = 20 * 60_000;
const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;
const BUILD_LIFETIME_MS = 3 * HOUR;
const ARCHIVE = "/tmp/t3-base.tar";

const ForkBase = Schema.Struct({
  imageId: Schema.String,
  /** The default-branch commit the image's checkout sits at. */
  sha: Schema.String,
  builtAt: Schema.Number,
});
export type ForkBase = typeof ForkBase.Type;

const ForkBaseRecord = Schema.Struct({
  repository: Schema.String,
  /** The ForkRepository key `bases` were built with. */
  key: Schema.String,
  /** Newest first. */
  bases: Schema.Array(ForkBase),
  /** When origin was last compared with the newest base. */
  checkedAt: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(
    Schema.Struct({ key: Schema.String, at: Schema.Number, message: Schema.String }),
  ),
});
export type ForkBaseRecord = typeof ForkBaseRecord.Type;
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ForkBaseRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ForkBaseRecord));

/** The image a copy boots from: the newest one built with the current key that is still usable. */
export const pickBase = (record: ForkBaseRecord | null, key: string, now: number) =>
  record?.key === key
    ? (record.bases.find((base) => now - base.builtAt < USABLE_MS) ?? null)
    : null;

/** Whether to compare origin with the newest base again. */
export const refreshDue = (record: ForkBaseRecord | null, key: string, now: number) =>
  record?.key === key && (record.checkedAt === null || now - record.checkedAt >= CHECK_EVERY_MS);

/** Whether a refresh builds a new image: origin moved past the newest base, or it is aging out. */
export const rebuildDue = (newest: ForkBase, tip: string, now: number) =>
  newest.sha !== tip || now - newest.builtAt >= RENEW_AFTER_MS;

/** Whether a failed build for `key` keeps another from starting yet. */
export const backingOff = (record: ForkBaseRecord | null, key: string, now: number) =>
  record?.failure?.key === key && now - record.failure.at < FAILURE_BACKOFF_MS;

/** The record once `built` exists, and the images it no longer keeps: past the newest two, and every older key's. */
export const afterBuild = (
  record: ForkBaseRecord | null,
  repository: string,
  key: string,
  built: ForkBase,
): { readonly record: ForkBaseRecord; readonly drop: ReadonlyArray<string> } => {
  const bases = [built, ...(record?.key === key ? record.bases : [])].slice(0, KEEP);
  const kept = new Set(bases.map((base) => base.imageId));
  return {
    record: { repository, key, bases, checkedAt: built.builtAt, failure: null },
    drop: (record?.bases ?? []).map((base) => base.imageId).filter((id) => !kept.has(id)),
  };
};

export class BaseUnavailable extends Schema.TaggedError<BaseUnavailable>()("BaseUnavailable", {
  reason: Schema.Literals(["building", "failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason === "building"
      ? "This repository's first copy is being built; this run stays here."
      : "This repository's copy could not be built; the server log says why, and it is tried again within the hour.";
  }
}

class BaseBuildFailed extends Schema.TaggedError<BaseBuildFailed>()("BaseBuildFailed", {
  step: Schema.Literals(["fetch", "pack", "create", "checkout", "prepare", "snapshot", "record"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Building the repository's base failed at its ${this.step} step.`;
  }
}

/**
 * Puts the default branch at `$4` into the checkout at `$2`: $1 the uploaded archive (a bundle of
 * the commits the image lacks, when it lacks any, and the ship paths), $3 the branch, $5 owner/name.
 */
const BUILD_SCRIPT = `set -eu
archive=$1; work=$2; branch=$3; sha=$4; repository=$5; stage=$1.d
mkdir -p "$stage" && tar -xf "$archive" -C "$stage"
if [ ! -d "$work/.git" ]; then
  mkdir -p "$work" && git init -q "$work"
  git -C "$work" remote add origin "https://github.com/$repository.git"
fi
cd "$work"
if [ -f "$stage/base.bundle" ]; then
  git fetch -q "$stage/base.bundle" "+refs/remotes/origin/$branch:refs/remotes/origin/$branch"
fi
git checkout -qf --detach "$sha"
gzip -dc "$stage/ship.tgz" | tar -x
`;

/** Ship paths are the worktree's (secrets, generated files), so no image keeps them. */
const CLEAN_SCRIPT = `cd "$1" && shift && rm -rf -- "$@" && rm -rf -- "${ARCHIVE}" "${ARCHIVE}.d"`;

const buildArgv = (
  archive: string,
  repository: ForkRepository,
  branch: string,
  sha: string,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  BUILD_SCRIPT,
  "t3-build",
  archive,
  repository.workDir,
  branch,
  sha,
  repository.repository,
];

export interface Bases {
  /**
   * The base a copy of `checkout` boots from now. Starts a due refresh in the background, which
   * nothing waits for. With no base yet, it starts the first build and fails `building`, or with
   * `waitForFirst` waits for that build.
   */
  readonly current: (
    checkout: Checkout,
    environment: Readonly<Record<string, string>>,
    waitForFirst: boolean,
  ) => Effect.Effect<ForkBase, BaseUnavailable>;
  /** Waits for every build and refresh in flight now to end, however it ends. */
  readonly idle: Effect.Effect<void>;
}

/**
 * `live` holds the sweep's job tags; a build adds its own while its sandbox exists. Builds run in
 * the scope this is made in, so a caller that stops waiting never cancels one.
 */
export const makeBases = Effect.fn("WorktreeForks.makeBases")(function* (
  host: WorktreeForksHost,
  sandboxes: ForkSandboxes,
  hostTag: string,
  live: Set<string>,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const stateDir = (yield* ServerConfig).stateDir;
  const hostHome = yield* HostProcess.HomeDirectory;
  const scope = yield* Effect.scope;
  const builds = new Map<string, Deferred.Deferred<ForkBase, BaseUnavailable>>();
  const recordPath = (repository: ForkRepository) =>
    NodePath.join(stateDir, "worktree-forks", `${repository.repository.replace("/", "__")}.json`);

  const readRecord = (repository: ForkRepository) =>
    Effect.sync(() => {
      try {
        return decodeRecord(NodeFS.readFileSync(recordPath(repository), "utf8"));
      } catch {
        return null;
      }
    });
  const writeRecord = (repository: ForkRepository, record: ForkBaseRecord) =>
    Effect.try({
      try: () => {
        const path = recordPath(repository);
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
        NodeFS.writeFileSync(`${path}.tmp`, encodeRecord(record));
        NodeFS.renameSync(`${path}.tmp`, path);
      },
      catch: (cause) => new BaseBuildFailed({ step: "record", cause }),
    });

  // Steps of one build, which has its own span.
  const onHost = Effect.fnUntraced(function* (
    step: BaseBuildFailed["step"],
    cwd: string,
    command: string,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    const result = yield* runner
      .run({
        command,
        args,
        cwd,
        timeout: "10 minutes",
        env: { COPYFILE_DISABLE: "1" },
        ...(stdin === undefined ? {} : { stdin }),
      })
      .pipe(Effect.mapError((cause) => new BaseBuildFailed({ step, cause })));
    if (result.code !== 0)
      return yield* new BaseBuildFailed({
        step,
        cause: new Error(
          `${command} ${args[0]} exited ${result.code}: ${result.stderr.slice(-2000)}`,
        ),
      });
    return result.stdout;
  });
  const inSandbox = Effect.fnUntraced(function* (
    step: BaseBuildFailed["step"],
    sandboxId: string,
    argv: ReadonlyArray<string>,
    options: { readonly env?: Readonly<Record<string, string>>; readonly workdir?: string } = {},
  ) {
    const result = yield* Effect.tryPromise({
      try: () => sandboxes.exec(sandboxId, argv, { timeoutMs: PREPARE_TIMEOUT_MS, ...options }),
      catch: (cause) => new BaseBuildFailed({ step, cause }),
    });
    if (result.exitCode !== 0)
      return yield* new BaseBuildFailed({
        step,
        cause: new Error(
          `exited ${result.exitCode}: ${`${result.stdout}${result.stderr}`.slice(-2000)}`,
        ),
      });
  });

  const build = Effect.fn("WorktreeForks.buildBase")(function* (
    checkout: Checkout,
    environment: Readonly<Record<string, string>>,
  ) {
    const { repository, root } = checkout;
    const record = yield* readRecord(repository);
    const from = pickBase(record, repository.key, yield* Clock.currentTimeMillis);
    const originHead = yield* runner
      .run({
        command: "git",
        args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        cwd: root,
      })
      .pipe(Effect.option);
    const branch =
      originHead._tag === "Some" && Number(originHead.value.code) === 0
        ? originHead.value.stdout.trim().replace(/^origin\//, "")
        : "main";
    yield* onHost("fetch", root, "git", ["fetch", "-q", "origin", branch]);
    const tip = (yield* onHost("fetch", root, "git", [
      "rev-parse",
      `refs/remotes/origin/${branch}`,
    ])).trim();
    const now = yield* Clock.currentTimeMillis;
    if (from !== null && record !== null && !rebuildDue(from, tip, now)) {
      yield* writeRecord(repository, { ...record, checkedAt: now });
      return from;
    }

    const dir = NodePath.join(stateDir, "worktree-forks", "tmp", NodeCrypto.randomUUID());
    yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdirSync(dir, { recursive: true })),
      () => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
    );
    const parts = ["ship.tgz"];
    if (from?.sha !== tip) {
      yield* onHost("pack", root, "git", [
        "bundle",
        "create",
        "-q",
        NodePath.join(dir, "base.bundle"),
        `refs/remotes/origin/${branch}`,
        ...(from === null ? [] : [`^${from.sha}`]),
      ]);
      parts.push("base.bundle");
    }
    const shipped = repository.ship.filter((path) => NodeFS.existsSync(NodePath.join(root, path)));
    yield* onHost(
      "pack",
      root,
      "tar",
      ["-czf", NodePath.join(dir, "ship.tgz"), "--null", "-T", "-"],
      shipped.map((path) => `${path}\0`).join(""),
    );
    yield* onHost("pack", dir, "tar", ["-cf", "state.tar", ...parts]);

    const job = `base-${repository.repository.replace("/", "__")}`;
    const sandboxId = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          live.add(job);
          return sandboxes.createCopy(
            copySpec(host, {
              imageId: from?.imageId ?? host.modal.imageId,
              size: host.sizes.get(host.defaultSize)!,
              lifetimeMs: BUILD_LIFETIME_MS,
              tags: { purpose: COPY_PURPOSE, host: hostTag, job },
            }),
          );
        },
        catch: (cause) => new BaseBuildFailed({ step: "create", cause }),
      }),
      (id) =>
        Effect.promise(() => sandboxes.terminate(id).catch(() => undefined)).pipe(
          Effect.ensuring(Effect.sync(() => live.delete(job))),
        ),
    ).pipe(Effect.onError(() => Effect.sync(() => live.delete(job))));
    yield* Effect.tryPromise({
      try: () => sandboxes.upload(sandboxId, NodePath.join(dir, "state.tar"), ARCHIVE),
      catch: (cause) => new BaseBuildFailed({ step: "checkout", cause }),
    });
    yield* inSandbox("checkout", sandboxId, buildArgv(ARCHIVE, repository, branch, tip));
    const prepareEnvironment = sandboxEnvironment(environment, root, hostHome);
    for (const command of repository.prepare)
      yield* inSandbox("prepare", sandboxId, ["bash", "-lc", command], {
        env: prepareEnvironment,
        workdir: repository.workDir,
      });
    yield* inSandbox("snapshot", sandboxId, [
      "sh",
      "-c",
      CLEAN_SCRIPT,
      "t3-clean",
      repository.workDir,
      ...repository.ship,
    ]);
    const imageId = yield* Effect.tryPromise({
      try: () => sandboxes.saveDisk(sandboxId, IMAGE_TTL_MS, SNAPSHOT_TIMEOUT_MS),
      catch: (cause) => new BaseBuildFailed({ step: "snapshot", cause }),
    });
    const built = { imageId, sha: tip, builtAt: yield* Clock.currentTimeMillis };
    const next = afterBuild(
      yield* readRecord(repository),
      repository.repository,
      repository.key,
      built,
    );
    yield* writeRecord(repository, next.record);
    yield* Effect.logInfo("worktree fork base built", {
      repository: repository.repository,
      imageId,
      sha: tip,
    });
    for (const dropped of next.drop)
      yield* Effect.tryPromise(() => sandboxes.deleteImage(dropped)).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("an old worktree fork base could not be deleted", { cause }),
        ),
      );
    return built;
  }, Effect.scoped);

  const settle = (checkout: Checkout, environment: Readonly<Record<string, string>>) =>
    build(checkout, environment).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          const { repository } = checkout;
          yield* Effect.logWarning("worktree fork base build failed", {
            repository: repository.repository,
            step: error.step,
            cause: error.cause,
          });
          const at = yield* Clock.currentTimeMillis;
          const record = yield* readRecord(repository);
          yield* writeRecord(repository, {
            ...(record ?? { repository: repository.repository, key: repository.key, bases: [] }),
            checkedAt: at,
            failure: { key: repository.key, at, message: error.message },
          }).pipe(Effect.ignore);
        }),
      ),
      Effect.mapError((cause) => new BaseUnavailable({ reason: "failed", cause })),
    );

  /** The build in flight for the checkout's repository, started now when there is none. */
  const buildOnce = Effect.fn("WorktreeForks.buildOnce")(function* (
    checkout: Checkout,
    environment: Readonly<Record<string, string>>,
  ) {
    const key = checkout.repository.repository;
    const running = builds.get(key);
    if (running !== undefined) return running;
    const done = Deferred.makeUnsafe<ForkBase, BaseUnavailable>();
    builds.set(key, done);
    yield* settle(checkout, environment).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => builds.delete(key)).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
      Effect.forkIn(scope),
    );
    return done;
  });

  const current: Bases["current"] = Effect.fn("WorktreeForks.currentBase")(
    function* (checkout, environment, waitForFirst) {
      const { key } = checkout.repository;
      const record = yield* readRecord(checkout.repository);
      const now = yield* Clock.currentTimeMillis;
      const base = pickBase(record, key, now);
      const blocked = backingOff(record, key, now);
      if (base !== null) {
        if (refreshDue(record, key, now) && !blocked) yield* buildOnce(checkout, environment);
        return base;
      }
      if (blocked) return yield* new BaseUnavailable({ reason: "failed" });
      const done = yield* buildOnce(checkout, environment);
      if (!waitForFirst) return yield* new BaseUnavailable({ reason: "building" });
      return yield* Deferred.await(done);
    },
  );

  const idle = Effect.suspend(() =>
    Effect.forEach([...builds.values()], (done) => Deferred.await(done).pipe(Effect.exit), {
      discard: true,
    }),
  );

  return { current, idle } satisfies Bases;
});
