// @effect-diagnostics nodeBuiltinImport:off - hashes this host's files and keeps a small index beside the base records.
/**
 * Archives a copy takes from this host (a worktree's state, each `--input` path), kept in Modal by
 * the sha256 of what they hold, so jobs that send the same content cost this host one upload, not
 * one each.
 *
 * The first job to need an archive uploads it, checks its digest in the copy, and saves the
 * directory holding it as a Modal directory image; only then does the image's id go into the
 * index under the content's key, so a cut-short or garbled upload is never served. Jobs needing
 * the same key meanwhile wait for that one upload. Later jobs mount the image instead, and a mount
 * is the copy's own: what a job writes there no other job sees. Anything going wrong in the cache
 * falls back to uploading the archive as before.
 *
 * Images live in the forks' own Modal workspace, app and environment. Modal deletes each a week
 * after it was taken; the sweep deletes one unused for a day, and none is mounted past six days.
 *
 * @module worktreeForkCache
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { fileDigest } from "../environmentControl/ProvisionPreparation.ts";
import type { ForkSandboxes, WorktreeForksHost } from "./worktreeForksConfig.ts";
import type { CheckoutRefused } from "./worktreeForkShip.ts";

const DAY = 24 * 3_600_000;
/** Modal deletes an image this long after it was taken, whatever becomes of this host. */
const IMAGE_TTL_MS = 7 * DAY;
/** No image is mounted this close to Modal's deletion of it. */
const USABLE_MS = 6 * DAY;
/** The sweep deletes an image no job has used for this long. */
const IDLE_MS = DAY;
/** Where a hit is mounted, and where the first upload of a key is checked and saved from. */
const MOUNTS = "/tmp/t3-cache";
const STAGES = "/tmp/t3-cache-stage";

/** Moves an upload ($1) into its own directory ($3) once its sha256 matches $2. */
const VERIFY_SCRIPT = `echo "$2  $1" | sha256sum -c --status && mkdir -p "$3" && mv "$1" "$3/archive"`;

/** An archive packed on this host for a copy, as it lands there. */
export interface Packed {
  readonly archive: string;
  readonly bytes: number;
  /** The key of what packing read, so content that changed while it was packed is never cached. */
  readonly key: string;
}

/** What a copy needs from this host: the key of its content, and how to pack it. */
export interface Upload {
  readonly key: string;
  readonly pack: Effect.Effect<Packed, CheckoutRefused>;
}

/** Where an archive is in the copy, how big it is, and how much of it this host sent. */
export interface Placed {
  readonly path: string;
  readonly bytes: number;
  readonly uploadedBytes: number;
}

export class UploadFailed extends Schema.TaggedError<UploadFailed>()("UploadFailed", {
  cause: Schema.Defect(),
}) {}

const Entry = Schema.Struct({
  imageId: Schema.String,
  bytes: Schema.Number,
  createdAt: Schema.Number,
  usedAt: Schema.Number,
});
type Entry = typeof Entry.Type;
const Index = Schema.Struct({
  /** The Modal workspace, app and environment the images live in. */
  scope: Schema.String,
  entries: Schema.Record(Schema.String, Entry),
});
const decodeIndex = Schema.decodeUnknownSync(Schema.fromJsonString(Index));
const encodeIndex = Schema.encodeSync(Schema.fromJsonString(Index));

export const makeUploadCache = Effect.fn("WorktreeForks.makeUploadCache")(function* (
  host: WorktreeForksHost,
  sandboxes: ForkSandboxes,
  stateDir: string,
) {
  const path = NodePath.join(stateDir, "worktree-forks", "upload-cache.json");
  const scope = NodeCrypto.createHash("sha256")
    .update([host.modal.tokenId, host.modal.app, host.modal.environment ?? ""].join("\0"))
    .digest("hex");
  const index = new Map<string, Entry>();
  yield* Effect.try(() => {
    if (!NodeFS.existsSync(path)) return;
    const saved = decodeIndex(NodeFS.readFileSync(path, "utf8"));
    // Another workspace's images are not this one's to mount; Modal expires them.
    if (saved.scope === scope)
      for (const [key, entry] of Object.entries(saved.entries)) index.set(key, entry);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("worktree fork upload cache could not be read; it starts empty", {
        path,
        cause,
      }),
    ),
  );
  const save = Effect.try(() => {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    const temporary = `${path}.${NodeCrypto.randomUUID()}`;
    NodeFS.writeFileSync(temporary, encodeIndex({ scope, entries: Object.fromEntries(index) }));
    NodeFS.renameSync(temporary, path);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("worktree fork upload cache could not be saved", { path, cause }),
    ),
  );
  /** Each key's first upload in progress, settling with what it committed, or null. */
  const uploading = new Map<string, Deferred.Deferred<Entry | null>>();

  const upload = (sandboxId: string, local: string, remote: string) =>
    Effect.tryPromise({
      try: () => sandboxes.upload(sandboxId, local, remote),
      catch: (cause) => new UploadFailed({ cause }),
    });

  /** Today's path: this job's own upload. */
  const direct = Effect.fnUntraced(function* (
    sandboxId: string,
    item: Upload,
    fallbackPath: string,
    packed?: Packed,
  ) {
    const archive = packed ?? (yield* item.pack);
    yield* upload(sandboxId, archive.archive, fallbackPath);
    return {
      path: fallbackPath,
      bytes: archive.bytes,
      uploadedBytes: archive.bytes,
    } satisfies Placed;
  });

  /** A cache problem: the job goes on with its own upload. */
  const fallBack = (message: string, key: string, cause?: unknown) =>
    Effect.logWarning(`worktree fork upload cache ${message}; uploading directly`, { key, cause });

  /** The first job needing `key`: uploads, checks and saves it, and commits it to the index. */
  const lead = Effect.fnUntraced(function* (
    sandboxId: string,
    item: Upload,
    fallbackPath: string,
    done: Deferred.Deferred<Entry | null>,
  ) {
    let committed: Entry | null = null;
    return yield* Effect.gen(function* () {
      const packed = yield* item.pack;
      const uploaded = `${STAGES}/${item.key}.upload`;
      const stage = `${STAGES}/${item.key}`;
      yield* upload(sandboxId, packed.archive, uploaded);
      const placed: Placed = {
        path: `${stage}/archive`,
        bytes: packed.bytes,
        uploadedBytes: packed.bytes,
      };
      const verified = yield* Effect.tryPromise(async () => {
        const digest = await fileDigest(packed.archive);
        return sandboxes.exec(
          sandboxId,
          ["sh", "-c", VERIFY_SCRIPT, "t3-verify", uploaded, digest, stage],
          { timeoutMs: 5 * 60_000 },
        );
      }).pipe(Effect.result);
      if (verified._tag === "Failure" || verified.success.exitCode !== 0) {
        yield* fallBack(
          "could not check an upload",
          item.key,
          verified._tag === "Failure" ? verified.failure : verified.success.stderr,
        );
        const again = yield* direct(sandboxId, item, fallbackPath, packed);
        return { ...again, uploadedBytes: packed.bytes + again.uploadedBytes };
      }
      if (packed.key !== item.key) {
        yield* Effect.logInfo("worktree fork upload changed while it was packed; not cached", {
          key: item.key,
        });
        return placed;
      }
      const saved = yield* Effect.tryPromise(() =>
        sandboxes.saveDirectory(sandboxId, stage, IMAGE_TTL_MS),
      ).pipe(Effect.result);
      if (saved._tag === "Failure") {
        yield* Effect.logWarning("worktree fork upload could not be cached", {
          key: item.key,
          cause: saved.failure,
        });
        return placed;
      }
      const now = yield* Clock.currentTimeMillis;
      committed = { imageId: saved.success, bytes: packed.bytes, createdAt: now, usedAt: now };
      const replaced = index.get(item.key);
      index.set(item.key, committed);
      yield* save;
      if (replaced !== undefined)
        yield* Effect.promise(() => sandboxes.deleteImage(replaced.imageId).catch(() => undefined));
      return placed;
    }).pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          uploading.delete(item.key);
          Deferred.doneUnsafe(done, Exit.succeed(committed));
        }),
      ),
    );
  });

  /**
   * Puts `item`'s archive in the copy: from the cache when it holds the key, else by the one upload
   * every job needing the key waits for, else at `fallbackPath` as before. Fails only as packing or
   * the job's own upload does.
   */
  const place = Effect.fn("WorktreeForks.placeUpload")(function* (
    sandboxId: string,
    item: Upload,
    fallbackPath: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    // One step, so two jobs never both lead the same key.
    const claim = yield* Effect.sync(() => {
      const entry = index.get(item.key);
      if (entry !== undefined && now - entry.createdAt < USABLE_MS)
        return { _tag: "cached", entry } as const;
      const pending = uploading.get(item.key);
      if (pending !== undefined) return { _tag: "waiting", pending } as const;
      const done = Deferred.makeUnsafe<Entry | null>();
      uploading.set(item.key, done);
      return { _tag: "leading", done } as const;
    });
    if (claim._tag === "leading") return yield* lead(sandboxId, item, fallbackPath, claim.done);
    const entry = claim._tag === "cached" ? claim.entry : yield* Deferred.await(claim.pending);
    if (entry === null) return yield* direct(sandboxId, item, fallbackPath);
    const mountPath = `${MOUNTS}/${item.key}`;
    const mounted = yield* Effect.tryPromise(() =>
      sandboxes.mountImage(sandboxId, mountPath, entry.imageId),
    ).pipe(Effect.result);
    if (mounted._tag === "Failure") {
      // Likely gone from Modal: the next job uploads it again.
      if (index.get(item.key) === entry) {
        index.delete(item.key);
        yield* save;
      }
      yield* fallBack("could not mount an image", item.key, mounted.failure);
      return yield* direct(sandboxId, item, fallbackPath);
    }
    index.set(item.key, { ...entry, usedAt: yield* Clock.currentTimeMillis });
    return { path: `${mountPath}/archive`, bytes: entry.bytes, uploadedBytes: 0 } satisfies Placed;
  });

  /** Deletes the images no job used for a day, or too close to Modal's own deletion to mount. */
  const evict = Effect.fn("WorktreeForks.evictUploads")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const stale = [...index].filter(
      ([, entry]) => now - entry.usedAt > IDLE_MS || now - entry.createdAt >= USABLE_MS,
    );
    for (const [key] of stale) index.delete(key);
    // Saved every sweep, which also keeps the hits' times since the last one.
    yield* save;
    yield* Effect.forEach(
      stale,
      ([, entry]) =>
        Effect.promise(() => sandboxes.deleteImage(entry.imageId).catch(() => undefined)),
      { concurrency: 8, discard: true },
    );
  });

  return { place, evict };
});
