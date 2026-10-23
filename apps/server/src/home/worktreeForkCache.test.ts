// @effect-diagnostics nodeBuiltinImport:off - archives and the cache's index are real files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { makeUploadCache, type Upload } from "./worktreeForkCache.ts";
import type { WorktreeForksHost } from "./worktreeForksConfig.ts";
import { makeFakeSandboxes } from "./worktreeForksTestkit.ts";

const HOUR = 3_600_000;

const setup = () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-cache-"));
  const archive = NodePath.join(stateDir, "input.tgz");
  NodeFS.writeFileSync(archive, "archive bytes");
  const item: Upload = {
    key: "a".repeat(64),
    pack: () => Effect.succeed({ archive, bytes: 13, key: "a".repeat(64) }),
  };
  const host = {
    modal: { tokenId: "ak", tokenSecret: "as", imageId: "im", app: "app", environment: undefined },
  } as unknown as WorktreeForksHost;
  const fake = makeFakeSandboxes();
  return { stateDir, item, host, fake, start: makeUploadCache(host, fake.port, stateDir) };
};

const copy = (fake: ReturnType<typeof makeFakeSandboxes>) =>
  Effect.promise(() =>
    fake.port.createCopy({
      app: "app",
      imageId: "im",
      timeoutMs: 60_000,
      sizing: { cpu: 1, cpuLimit: 1, memoryMiB: 1, memoryLimitMiB: 1 },
      tags: {},
      egress: { domains: [], cidrs: [] },
    }),
  );

const uploads = (fake: ReturnType<typeof makeFakeSandboxes>) =>
  fake.calls.filter((call) => call.op === "upload").length;

it.effect("the sweep deletes an image unused for a day, and one too old to mount", () => {
  const { item, fake, start, stateDir, host } = setup();
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
    const kept = yield* makeUploadCache(host, fake.port, stateDir);
    expect((yield* kept.place(yield* copy(fake), item, "/tmp/input.tgz")).uploadedBytes).toBe(0);
    const other = yield* makeUploadCache(
      { ...host, modal: { ...host.modal, tokenId: "ak-other" } },
      fake.port,
      stateDir,
    );
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
