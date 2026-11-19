// @effect-diagnostics nodeBuiltinImport:off - archives and the cache's index are real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { makeUploadCache, type Upload } from "./worktreeForkCache.ts";
import { CheckoutRefused } from "./worktreeForkShip.ts";
import type { ModalPlatform } from "./worktreeForksConfig.ts";
import { makeFakeSandboxes } from "./worktreeForksTestkit.ts";

const HOUR = 3_600_000;

const setup = (directoryImages = true, memoryRoot: string | null = null) => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-cache-"));
  const archive = NodePath.join(stateDir, "input.tgz");
  NodeFS.writeFileSync(archive, "archive bytes");
  const item: Upload = {
    key: "a".repeat(64),
    pack: () => Effect.succeed({ archive, bytes: 13, key: "a".repeat(64) }),
  };
  const platform: ModalPlatform = {
    kind: "modal",
    tokenId: "ak",
    tokenSecret: "as",
    imageId: "im",
    app: "app",
    environment: undefined,
  };
  const fake = makeFakeSandboxes({ directoryImages });
  return {
    stateDir,
    item,
    platform,
    fake,
    start: makeUploadCache(platform, fake.port, stateDir, memoryRoot),
  };
};

const copy = (fake: ReturnType<typeof makeFakeSandboxes>) =>
  Effect.promise(() =>
    fake.port.createCopy({
      imageId: "im",
      size: { cpu: 1, memoryMiB: 1, cpuRequest: 1, memoryRequestMiB: 1 },
      lifetimeMs: 60_000,
      tags: {},
    }),
  );

const uploads = (fake: ReturnType<typeof makeFakeSandboxes>) =>
  fake.calls.filter((call) => call.op === "upload").length;

it.effect("the sweep deletes an image unused for a day, and one too old to mount", () => {
  const { item, fake, start, stateDir, platform } = setup();
  return Effect.gen(function* () {
    const cache = yield* start;
    yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    const [imageId] = fake.directories.keys();

    // Used again within a day, it stays.
    yield* TestClock.adjust(23 * HOUR);
    expect((yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(0);
    yield* TestClock.adjust(2 * HOUR);
    yield* cache.evict();
    expect(fake.directories.has(imageId!)).toBe(true);

    // A day without use, it goes, and the next job uploads it again.
    yield* TestClock.adjust(25 * HOUR);
    yield* cache.evict();
    expect(fake.directories.has(imageId!)).toBe(false);
    expect(fake.calls.filter((call) => call.op === "deleteImage")).toHaveLength(1);
    const before = uploads(fake);
    yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    expect(uploads(fake)).toBe(before + 1);

    // Used every day, it is still replaced six days on, before Modal deletes it under a mount.
    const [renewed] = fake.directories.keys();
    const renewing = uploads(fake);
    for (let hours = 20; hours < 6 * 24; hours += 20) {
      yield* TestClock.adjust(20 * HOUR);
      yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
      yield* cache.evict();
    }
    expect(uploads(fake)).toBe(renewing);
    yield* TestClock.adjust(20 * HOUR);
    yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    expect(uploads(fake)).toBe(renewing + 1);
    expect(fake.directories.has(renewed!)).toBe(false);
    expect(fake.directories.size).toBe(1);

    // The index outlives a restart, and another Modal workspace's is not used.
    const kept = yield* makeUploadCache(platform, fake.port, stateDir);
    expect((yield* kept.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(0);
    // Each platform has its own index; one from before they did is still read.
    const indexes = NodePath.join(stateDir, "worktree-forks");
    NodeFS.renameSync(
      NodePath.join(indexes, "upload-cache.modal.json"),
      NodePath.join(indexes, "upload-cache.json"),
    );
    const unsuffixed = yield* makeUploadCache(platform, fake.port, stateDir);
    expect((yield* unsuffixed.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(
      0,
    );
    const other = yield* makeUploadCache({ ...platform, tokenId: "ak-other" }, fake.port, stateDir);
    expect((yield* other.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(13);
  }).pipe(Effect.scoped);
});

it.effect("a cache that errs falls back to the job's own upload, and says so", () => {
  const { item, fake, start } = setup();
  const warnings: Array<unknown> = [];
  const logging = Logger.layer(
    [
      Logger.make(
        ({ message }) => void warnings.push(Array.isArray(message) ? message[0] : message),
      ),
    ],
    { mergeWithExisting: false },
  );
  return Effect.gen(function* () {
    const cache = yield* start;

    // Not saved: the job uses its own upload, and nothing is kept.
    fake.failNext("saveDirectory", new Error("snapshot failed"));
    const unsaved = yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    expect(unsaved).toMatchObject({ uploadedBytes: 13 });
    expect(fake.directories.size).toBe(0);

    yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    expect(fake.directories.size).toBe(1);

    // Its image will not mount: this job uploads as before, and the next keeps a fresh one.
    fake.failNext("mount", new Error("Could not find image"));
    const unmounted = yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    expect(unmounted).toEqual({ path: "/tmp/input.tgz", bytes: 13, uploadedBytes: 13 });
    expect(warnings).toContain(
      "worktree fork upload cache could not mount an image; uploading directly",
    );
    const before = fake.calls.filter((call) => call.op === "saveDirectory").length;
    yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
    expect(fake.calls.filter((call) => call.op === "saveDirectory")).toHaveLength(before + 1);
    expect((yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(logging));
});

it.effect("content that changed while it was packed is used once and never cached", () => {
  const { item, fake, start } = setup();
  return Effect.gen(function* () {
    const cache = yield* start;
    const moved: Upload = {
      key: item.key,
      pack: (dir) =>
        item.pack(dir).pipe(Effect.map((packed) => ({ ...packed, key: "b".repeat(64) }))),
    };
    expect((yield* cache.place(yield* copy(fake), moved, "/tmp/input.tgz")).uploadedBytes).toBe(13);
    expect(fake.calls.filter((call) => call.op === "saveDirectory")).toEqual([]);
    expect((yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(13);
  }).pipe(Effect.scoped);
});

it.effect("a platform with no directory images sends every archive directly", () => {
  const { item, fake, start } = setup(false);
  return Effect.gen(function* () {
    const cache = yield* start;
    for (let job = 0; job < 2; job++) {
      const placed = yield* cache.place(yield* copy(fake), item, "/tmp/input.tgz");
      expect(placed).toEqual({ path: "/tmp/input.tgz", bytes: 13, uploadedBytes: 13 });
    }
    expect(uploads(fake)).toBe(2);
    expect(fake.calls.filter((call) => call.op === "exec")).toEqual([]);
  }).pipe(Effect.scoped);
});

/** An item that records where each pack ran, failing a pack in `full` the way a full tmpfs does. */
const recording = (item: Upload, dirs: Array<string>, full?: string) =>
  ({
    key: item.key,
    pack: (dir) => {
      dirs.push(dir);
      return full !== undefined && dir.startsWith(full)
        ? Effect.fail(
            new CheckoutRefused({
              reason: "unreadable",
              cause: new Error(
                "tar exited 2: tar: state.tar: Cannot write: No space left on device",
              ),
            }),
          )
        : item.pack(dir);
    },
  }) satisfies Upload;

it.effect("packs in the tmpfs when the host has one, else on the disk", () => {
  const memoryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-shm-"));
  const withMemory = setup(false, memoryRoot);
  const withoutMemory = setup(false);
  return Effect.gen(function* () {
    const inMemory: Array<string> = [];
    const memory = yield* withMemory.start;
    yield* memory.place(yield* copy(withMemory.fake), recording(withMemory.item, inMemory), "/x");
    expect(inMemory).toHaveLength(1);
    expect(NodePath.dirname(inMemory[0]!)).toBe(NodePath.join(memoryRoot, "packs"));

    const onDisk: Array<string> = [];
    const disk = yield* withoutMemory.start;
    yield* disk.place(yield* copy(withoutMemory.fake), recording(withoutMemory.item, onDisk), "/x");
    expect(NodePath.dirname(onDisk[0]!)).toBe(
      NodePath.join(withoutMemory.stateDir, "worktree-forks", "tmp", "packs"),
    );
  }).pipe(Effect.scoped);
});

it.effect("a pack that fills the tmpfs is packed again on the disk; other failures stay", () => {
  const memoryRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-shm-"));
  const { item, fake, start, stateDir } = setup(false, memoryRoot);
  return Effect.gen(function* () {
    const cache = yield* start;
    const dirs: Array<string> = [];
    const placed = yield* cache.place(yield* copy(fake), recording(item, dirs, memoryRoot), "/x");
    expect(placed.uploadedBytes).toBe(13);
    expect(dirs).toHaveLength(2);
    expect(dirs[0]!.startsWith(memoryRoot)).toBe(true);
    expect(dirs[1]!.startsWith(NodePath.join(stateDir, "worktree-forks", "tmp", "packs"))).toBe(
      true,
    );
    expect(NodeFS.existsSync(dirs[0]!)).toBe(false);

    const broken: Upload = {
      key: "c".repeat(64),
      pack: () =>
        Effect.fail(new CheckoutRefused({ reason: "unreadable", cause: new Error("boom") })),
    };
    const failed = yield* cache.place(yield* copy(fake), broken, "/x").pipe(Effect.flip);
    expect(failed).toMatchObject({ _tag: "CheckoutRefused", reason: "unreadable" });
  }).pipe(Effect.scoped);
});
