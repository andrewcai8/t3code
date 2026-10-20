// @effect-diagnostics nodeBuiltinImport:off - real git plays the host, and the build script runs under real sh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  afterBuild,
  backingOff,
  type ForkBaseRecord,
  makeBases,
  pickBase,
  rebuildDue,
  refreshDue,
} from "./worktreeForkBases.ts";
import type { ForkRepository, WorktreeForksHost } from "./worktreeForksConfig.ts";
import { isCommand, isStep, makeFakeSandboxes } from "./worktreeForksTestkit.ts";
import type { Checkout } from "./worktreeForkShip.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=T3",
      "-c",
      "user.email=t3@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

const tempDir = (label: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3wf-${label}-`)));

const commit = (repo: string, file: string, text: string) => {
  NodeFS.writeFileSync(NodePath.join(repo, file), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `write ${file}`);
  return git(repo, "rev-parse", "HEAD");
};

/** Runs a sandbox step on this machine, reading the archive it was uploaded with. */
const runLocally = (argv: ReadonlyArray<string>, uploaded: ReadonlyMap<string, string>) => {
  const local = argv.map((arg) => uploaded.get(arg) ?? arg);
  try {
    NodeChildProcess.execFileSync(local[0]!, local.slice(1), { stdio: "pipe" });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? 1;
  }
};

/**
 * An upstream on "GitHub" (an insteadOf rewrite to a local repo), a host checkout of it with an
 * ignored ship path, and the directory a copy's checkout lives in.
 */
const setup = () => {
  const upstream = tempDir("upstream");
  git(upstream, "init", "-q");
  NodeFS.writeFileSync(NodePath.join(upstream, ".gitignore"), ".env\n");
  const first = commit(upstream, "a.txt", "one\n");
  const root = NodePath.join(tempDir("host"), "widgets");
  git(NodePath.dirname(root), "clone", "-q", upstream, root);
  git(root, "remote", "set-url", "origin", "git@github.com:acme/widgets.git");
  git(root, "config", `url.${upstream}.insteadOf`, "git@github.com:acme/widgets.git");
  NodeFS.writeFileSync(NodePath.join(root, ".env"), "TOKEN=1\n");
  const workDir = NodePath.join(tempDir("work"), "widgets");
  const repository: ForkRepository = {
    repository: "acme/widgets",
    workDir,
    prepare: ["make prepare"],
    services: [],
    ship: [".env"],
    key: "key-1",
  };
  const host: WorktreeForksHost = {
    modal: {
      tokenId: "ak",
      tokenSecret: "as",
      imageId: "im-template",
      app: "t3-worktree-forks",
      environment: undefined,
    },
    sizes: new Map([["default", { cpu: 8, memoryMiB: 16384 }]]),
    defaultSize: "default",
    maxConcurrent: 8,
    maxJobMs: 120 * 60_000,
    maxCopyBackBytes: 100 * 1024 * 1024,
    repositories: new Map([[repository.repository, repository]]),
    bunShim: null,
  };
  const checkout: Checkout = {
    root,
    cwd: root,
    repository,
    head: git(root, "rev-parse", "HEAD"),
    branch: "main",
  };
  const fake = makeFakeSandboxes();
  fake.onExec(isStep("t3-build"), { run: runLocally });
  fake.onExec(isStep("t3-clean"), { run: runLocally });
  return { upstream, first, workDir, host, checkout, fake };
};

const environment = { HOME: "/home/me", PATH: "/usr/bin", API_KEY: "k" };

const layer = () =>
  Layer.mergeAll(
    ProcessRunner.layer,
    ServerConfig.layerTest(process.cwd(), tempDir("t3home")),
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, "/home/me")),
  );

const creates = (fake: ReturnType<typeof makeFakeSandboxes>) =>
  fake.calls.filter((call) => call.op === "create");

it("picks the newest usable base of the current key, and refreshes at most hourly", () => {
  const record: ForkBaseRecord = {
    repository: "acme/widgets",
    key: "k",
    bases: [
      { imageId: "im-new", sha: "b", builtAt: 13 * DAY },
      { imageId: "im-old", sha: "a", builtAt: 0 },
    ],
    checkedAt: 13 * DAY,
    failure: null,
  };
  expect(pickBase(record, "k", 13 * DAY + HOUR)?.imageId).toBe("im-new");
  expect(pickBase({ ...record, bases: record.bases.slice(1) }, "k", 13 * DAY)).toBeNull();
  expect(pickBase(record, "other", 13 * DAY)).toBeNull();
  expect(pickBase(null, "k", 0)).toBeNull();

  expect(refreshDue(record, "k", 13 * DAY + HOUR - 1)).toBe(false);
  expect(refreshDue(record, "k", 13 * DAY + HOUR)).toBe(true);
  expect(refreshDue({ ...record, checkedAt: null }, "k", 0)).toBe(true);
  expect(refreshDue(record, "other", 20 * DAY)).toBe(false);

  const newest = record.bases[0]!;
  expect(rebuildDue(newest, "b", 13 * DAY + HOUR)).toBe(false);
  expect(rebuildDue(newest, "c", 13 * DAY + HOUR)).toBe(true);
  expect(rebuildDue(newest, "b", 20 * DAY)).toBe(true);

  const failed = { ...record, failure: { key: "k", at: 0, message: "no" } };
  expect(backingOff(failed, "k", HOUR - 1)).toBe(true);
  expect(backingOff(failed, "k", HOUR)).toBe(false);
  expect(backingOff(failed, "other", 0)).toBe(false);
});

it("keeps the two newest bases of the current key and drops every other image", () => {
  const record: ForkBaseRecord = {
    repository: "acme/widgets",
    key: "k",
    bases: [
      { imageId: "im-2", sha: "b", builtAt: 2 },
      { imageId: "im-1", sha: "a", builtAt: 1 },
    ],
    checkedAt: 2,
    failure: { key: "k", at: 2, message: "an earlier failure" },
  };
  const built = { imageId: "im-3", sha: "c", builtAt: 3 };
  expect(afterBuild(record, "acme/widgets", "k", built)).toEqual({
    record: {
      repository: "acme/widgets",
      key: "k",
      bases: [built, record.bases[0]],
      checkedAt: 3,
      failure: null,
    },
    drop: ["im-1"],
  });
  expect(afterBuild(record, "acme/widgets", "new-key", built)).toEqual({
    record: expect.objectContaining({ key: "new-key", bases: [built] }),
    drop: ["im-2", "im-1"],
  });
});

it.effect(
  "the first copy starts one build that later callers join; it prepares with the ship paths and keeps none",
  () =>
    Effect.gen(function* () {
      const { upstream, workDir, host, checkout, fake } = setup();
      const shipPathDuringPrepare: Array<boolean> = [];
      fake.onExec(isCommand("make prepare"), {
        run: () => {
          shipPathDuringPrepare.push(NodeFS.existsSync(NodePath.join(workDir, ".env")));
          return 0;
        },
      });
      const held = fake.hold("saveDisk");
      const bases = yield* makeBases(host, fake.port, "host-1", new Set());

      expect((yield* bases.current(checkout, environment, false).pipe(Effect.flip)).reason).toBe(
        "building",
      );
      expect((yield* bases.current(checkout, environment, false).pipe(Effect.flip)).reason).toBe(
        "building",
      );
      const waiter = yield* bases.current(checkout, environment, true).pipe(Effect.forkChild);
      yield* Effect.promise(() => held.reached);
      held.open();
      const base = yield* Fiber.join(waiter);

      expect(base.sha).toBe(git(upstream, "rev-parse", "HEAD"));
      expect(creates(fake)).toEqual([
        expect.objectContaining({
          imageId: "im-template",
          cpu: 8,
          tags: { purpose: "t3-worktree-fork", host: "host-1", job: "base-acme__widgets" },
        }),
      ]);
      expect(git(workDir, "rev-parse", "HEAD")).toBe(base.sha);
      expect(git(workDir, "remote", "get-url", "origin")).toBe(
        "https://github.com/acme/widgets.git",
      );
      expect(shipPathDuringPrepare).toEqual([true]);
      expect(NodeFS.existsSync(NodePath.join(workDir, ".env"))).toBe(false);
      const prepare = fake.calls.find((call) => call.argv?.[2] === "make prepare");
      expect(prepare).toMatchObject({
        workdir: workDir,
        env: { API_KEY: "k", HOME: "/home/user", USER: "root" },
      });
      expect(
        fake.calls.map((call) =>
          call.op === "exec"
            ? call.argv?.[0] === "bash"
              ? call.argv[2]
              : call.argv?.[3]
            : call.op,
        ),
      ).toEqual([
        "create",
        "upload",
        "t3-build",
        "make prepare",
        "t3-clean",
        "saveDisk",
        "terminate",
      ]);
      expect(fake.running().size).toBe(0);
      expect(yield* bases.current(checkout, environment, false)).toEqual(base);
      expect(creates(fake)).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("a caller that stops waiting leaves the build running", () =>
  Effect.gen(function* () {
    const { host, checkout, fake } = setup();
    const held = fake.hold("saveDisk");
    const bases = yield* makeBases(host, fake.port, "host-1", new Set());
    const waiter = yield* bases.current(checkout, environment, true).pipe(Effect.forkChild);
    yield* Effect.promise(() => held.reached);
    yield* Fiber.interrupt(waiter);
    held.open();
    yield* bases.idle;
    expect((yield* bases.current(checkout, environment, false)).imageId).toMatch(/^im-/);
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("refreshes in the background once origin moves, on top of the previous base", () =>
  Effect.gen(function* () {
    const { upstream, workDir, host, checkout, fake } = setup();
    const bases = yield* makeBases(host, fake.port, "host-1", new Set());
    const first = yield* bases.current(checkout, environment, true);

    const moved = commit(upstream, "b.txt", "two\n");
    yield* TestClock.adjust("1 hour");
    expect(yield* bases.current(checkout, environment, false)).toEqual(first);
    yield* bases.idle;
    const second = yield* bases.current(checkout, environment, false);
    expect(second.sha).toBe(moved);
    expect(creates(fake).map((call) => call.imageId)).toEqual(["im-template", first.imageId]);
    expect(git(workDir, "rev-parse", "HEAD")).toBe(moved);

    commit(upstream, "c.txt", "three\n");
    yield* TestClock.adjust("1 hour");
    yield* bases.current(checkout, environment, false);
    yield* bases.idle;
    expect(fake.calls).toContainEqual({ op: "deleteImage", imageId: first.imageId });
    expect(fake.images.has(second.imageId)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("with origin unchanged it only checks again, until the base is a week old", () =>
  Effect.gen(function* () {
    const { host, checkout, fake } = setup();
    const bases = yield* makeBases(host, fake.port, "host-1", new Set());
    const first = yield* bases.current(checkout, environment, true);
    yield* TestClock.adjust("1 hour");
    yield* bases.current(checkout, environment, false);
    yield* bases.idle;
    expect(creates(fake)).toHaveLength(1);

    yield* TestClock.adjust("7 days");
    yield* bases.current(checkout, environment, false);
    yield* bases.idle;
    const renewed = yield* bases.current(checkout, environment, false);
    expect(creates(fake)).toHaveLength(2);
    expect(renewed.sha).toBe(first.sha);
    expect(renewed.imageId).not.toBe(first.imageId);
  }).pipe(Effect.scoped, Effect.provide(layer())),
);

it.effect("a failed build is not tried again for an hour", () =>
  Effect.gen(function* () {
    const { host, checkout, fake } = setup();
    fake.onExec(isCommand("make prepare"), { exitCode: 1, stdout: "prepare broke" });
    const bases = yield* makeBases(host, fake.port, "host-1", new Set());
    expect((yield* bases.current(checkout, environment, true).pipe(Effect.flip)).reason).toBe(
      "failed",
    );
    expect(fake.running().size).toBe(0);
    expect((yield* bases.current(checkout, environment, false).pipe(Effect.flip)).reason).toBe(
      "failed",
    );
    expect(creates(fake)).toHaveLength(1);
    yield* TestClock.adjust("1 hour");
    expect((yield* bases.current(checkout, environment, false).pipe(Effect.flip)).reason).toBe(
      "building",
    );
    yield* bases.idle;
    expect(creates(fake)).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(layer())),
);
