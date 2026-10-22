// @effect-diagnostics nodeBuiltinImport:off - real git plays the host's worktree; logs and outputs are real files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type FleetForkRunInput,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ForkExecRequest } from "./forkExecProtocol.ts";
import * as WorktreeForks from "./WorktreeForks.ts";
import type { ForkRepository, WorktreeForksHost } from "./worktreeForksConfig.ts";
import { gate, isCommand, isStep, makeFakeSandboxes } from "./worktreeForksTestkit.ts";

const owner = ThreadId.make("thread-owner");

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

/**
 * A worktree of acme/widgets on this host whose repository already has a base at its first
 * commit, the service over a fake Modal, and what it needs from the server.
 */
const setup = (
  options: { readonly maxConcurrent?: number; readonly services?: ReadonlyArray<string> } = {},
) => {
  const home = tempDir("t3home");
  const upstream = tempDir("upstream");
  git(upstream, "init", "-q");
  NodeFS.writeFileSync(NodePath.join(upstream, "a.txt"), "one\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "first");
  const baseSha = git(upstream, "rev-parse", "HEAD");
  const root = NodePath.join(tempDir("host"), "widgets");
  git(NodePath.dirname(root), "clone", "-q", upstream, root);
  // GitHub, as the repository list sees it, served from the local upstream.
  git(root, "remote", "set-url", "origin", "https://github.com/acme/widgets.git");
  git(root, "config", `url.${upstream}.insteadOf`, "https://github.com/acme/widgets.git");
  NodeFS.writeFileSync(NodePath.join(root, "a.txt"), "edited\n");
  const repository: ForkRepository = {
    repository: "acme/widgets",
    workDir: "/work/widgets",
    prepare: [],
    services: options.services ?? [],
    ship: [],
    key: "key-1",
  };
  const host: WorktreeForksHost = {
    modal: {
      tokenId: "ak",
      tokenSecret: "as",
      imageId: "im-template",
      app: "app",
      environment: undefined,
    },
    sizes: new Map([
      ["default", { cpu: 8, memoryMiB: 16384, cpuRequest: 2, memoryRequestMiB: 8192 }],
      ["large", { cpu: 16, memoryMiB: 32768, cpuRequest: 4, memoryRequestMiB: 16384 }],
    ]),
    defaultSize: "default",
    maxConcurrent: options.maxConcurrent ?? 8,
    maxJobMs: 120 * 60_000,
    maxCopyBackBytes: 100 * 1024 * 1024,
    repositories: new Map([[repository.repository, repository]]),
    bunShim: null,
  };
  const stateDir = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(NodePath.join(stateDir, "worktree-forks"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "worktree-forks", "acme__widgets.json"),
    JSON.stringify({
      repository: "acme/widgets",
      key: "key-1",
      bases: [{ imageId: "im-base", sha: baseSha, builtAt: 0 }],
      checkedAt: 0,
      failure: null,
    }),
  );
  const fake = makeFakeSandboxes();
  const layer = Layer.mergeAll(
    ProcessRunner.layer,
    ServerConfig.layerTest(process.cwd(), home),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getDescriptor: Effect.succeed({ environmentId: EnvironmentId.make("env-host") } as never),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          worktreePath: root,
          projectId: ProjectId.make("project"),
        } as unknown as OrchestrationV2ThreadShell),
    }),
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, "/Users/me")),
    Layer.provideMerge(
      Layer.succeed(HostProcess.Environment, { PATH: "/usr/bin", SERVER_ONLY: "yes" }),
    ),
  );
  const start = WorktreeForks.make(host, fake.port);
  return { root, stateDir, fake, layer, start };
};

const request = (root: string, overrides: Partial<ForkExecRequest> = {}): ForkExecRequest => ({
  command: "bun test",
  cwd: root,
  environment: {
    HOME: "/Users/me",
    PATH: `${root}/node_modules/.bin:/usr/bin`,
    T3CODE_HOME: "/Users/me/.t3",
    API_URL: "https://api.example.com",
  },
  ...overrides,
});

/** Records what a fork-exec caller sees, in order. */
const watcher = () => {
  const seen: Array<string> = [];
  const started = Deferred.makeUnsafe<void>();
  return {
    seen,
    started,
    observer: {
      started: (jobId: string) =>
        Effect.sync(() => seen.push(`started ${jobId.length > 0}`)).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
        ),
      output: (stream: "stdout" | "stderr", text: string) => void seen.push(`${stream} ${text}`),
    },
  };
};

const labels = (fake: ReturnType<typeof makeFakeSandboxes>) =>
  fake.calls.map((call) =>
    call.op === "exec" ? (call.argv?.[0] === "bash" ? call.argv[2] : call.argv?.[3]) : call.op,
  );

it.effect(
  "runs a command in a copy of the worktree and streams its output after the banner",
  () => {
    const { root, fake, layer, start } = setup();
    return Effect.gen(function* () {
      fake.onExec(isCommand("bun test"), {
        exitCode: 3,
        chunks: [
          ["stdout", "pass 1\n"],
          ["stderr", "warn\n"],
          ["stdout", "fail 2\n"],
        ],
      });
      const forks = yield* start;
      const { seen, observer } = watcher();
      const outcome = yield* forks.exec(request(root, { size: "large" }), observer);

      expect(outcome).toMatchObject({ _tag: "Exited", exitCode: 3, timedOut: false });
      expect(seen).toEqual(["started true", "stdout pass 1\n", "stderr warn\n", "stdout fail 2\n"]);
      expect(labels(fake)).toEqual([
        "create",
        "upload",
        "t3-apply",
        "t3-place",
        "stream",
        "terminate",
      ]);
      const create = fake.calls.find((call) => call.op === "create");
      expect(create).toMatchObject({
        imageId: "im-base",
        cpu: 16,
        tags: { purpose: "t3-worktree-fork", host: "env-host" },
      });
      expect(fake.calls.find((call) => call.argv?.[3] === "t3-place")?.argv?.slice(4)).toEqual([
        root,
        "/work/widgets",
      ]);
      const run = fake.calls.find((call) => call.op === "stream");
      expect(run?.argv?.slice(-3)).toEqual(["bash", "-lc", "bun test"]);
      expect(run).toMatchObject({
        workdir: root,
        env: {
          HOME: "/home/user",
          API_URL: "https://api.example.com",
          PATH: `${root}/node_modules/.bin:/home/user/.bun/bin:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        },
      });
      expect(run?.env).not.toHaveProperty("T3CODE_HOME");
      expect(fake.running().size).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

it.effect(
  "anything that fails before the command starts leaves the caller to run it, with no banner",
  () =>
    Effect.gen(function* () {
      const cases: Array<{
        readonly arrange: (fake: ReturnType<typeof makeFakeSandboxes>) => void;
        readonly overrides?: Partial<ForkExecRequest>;
        readonly services?: ReadonlyArray<string>;
        readonly message: RegExp;
      }> = [
        {
          arrange: () => {},
          overrides: { size: "huge" },
          message: /no size huge; it has default, large/,
        },
        {
          arrange: () => {},
          overrides: { cwd: tempDir("elsewhere") },
          message: /not inside a git checkout/,
        },
        {
          arrange: () => {},
          overrides: { inputs: ["/nonexistent/t3wf-input.json"] },
          message: /given as an input does not exist/,
        },
        {
          arrange: (fake) => fake.failNext("create", new Error("no capacity")),
          message: /Modal could not start a copy/,
        },
        {
          arrange: (fake) => fake.onExec(isStep("t3-apply"), { exitCode: 1, stdout: "bad tar" }),
          message: /could not apply this worktree's state/,
        },
        {
          arrange: (fake) =>
            fake.onExec(isStep("t3-services"), { exitCode: 2, stdout: "redis would not start" }),
          services: ["bash backend.sh start"],
          message: /exited 2 in the copy:\nredis would not start/,
        },
      ];
      for (const { arrange, overrides, services, message } of cases) {
        const { root, fake, layer, start } = setup(services ? { services } : {});
        arrange(fake);
        const { seen, observer } = watcher();
        const outcome = yield* Effect.gen(function* () {
          const forks = yield* start;
          return yield* forks.exec(request(root, overrides), observer);
        }).pipe(Effect.scoped, Effect.provide(layer));
        expect(outcome._tag).toBe("NotStarted");
        expect(outcome._tag === "NotStarted" ? outcome.message : "").toMatch(message);
        expect(seen).toEqual([]);
        expect(fake.calls.some((call) => call.op === "stream")).toBe(false);
        expect(fake.running().size).toBe(0);
      }
    }),
);

it.effect("a repository's first run stays local while its base is built", () => {
  const { root, stateDir, fake, layer, start } = setup();
  NodeFS.rmSync(NodePath.join(stateDir, "worktree-forks", "acme__widgets.json"));
  return Effect.gen(function* () {
    const held = fake.hold("create");
    const forks = yield* start;
    const outcome = yield* forks.exec(request(root), watcher().observer);
    expect(outcome).toEqual({
      _tag: "NotStarted",
      message: "This repository's first copy is being built; this run stays here.",
    });
    yield* Effect.promise(() => held.reached);
    expect(fake.calls.at(-1)).toMatchObject({
      op: "create",
      imageId: "im-template",
      tags: { job: "base-acme__widgets" },
    });
    held.open();
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("a copy lost after the banner is reported lost, and its sandbox still ends", () => {
  const { root, fake, layer, start } = setup();
  return Effect.gen(function* () {
    fake.failNext("stream", new Error("connection reset"));
    const forks = yield* start;
    const { seen, observer } = watcher();
    const outcome = yield* forks.exec(request(root), observer);
    expect(outcome).toEqual({ _tag: "Lost", message: "Its Modal sandbox stopped answering." });
    expect(seen).toEqual(["started true"]);
    expect(fake.running().size).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("inputs reach the copy at their own paths, and outputs come back to theirs", () => {
  const { root, fake, layer, start } = setup();
  const input = NodePath.join(tempDir("inputs"), "snapshot.json");
  NodeFS.writeFileSync(input, "{}\n");
  const output = NodePath.join(tempDir("outputs"), "run");
  // What the copy packs from its root: the output's own path without the leading slash.
  const packed = tempDir("packed");
  NodeFS.mkdirSync(NodePath.join(packed, output), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(packed, output, "report.json"), "done\n");
  NodeChildProcess.execFileSync("tar", ["-czf", "out.tgz", output.slice(1)], { cwd: packed });
  return Effect.gen(function* () {
    let shipped: Array<string> = [];
    fake.onExec(isStep("t3-inputs"), {
      run: (argv, uploaded) => {
        shipped = NodeChildProcess.execFileSync("tar", ["-tzf", uploaded.get(argv[4]!)!])
          .toString()
          .split("\n")
          .filter((line) => line !== "");
        return 0;
      },
    });
    fake.onExec(isStep("t3-outputs"), { exitCode: 0, stdout: "/nowhere\0" });
    fake.downloadFrom(NodePath.join(packed, "out.tgz"));
    const forks = yield* start;
    const { seen, observer } = watcher();
    const outcome = yield* forks.exec(
      request(root, { inputs: [input], outputs: [output, "/nowhere"] }),
      observer,
    );

    expect(outcome).toMatchObject({ _tag: "Exited", exitCode: 0 });
    expect(labels(fake)).toEqual([
      "create",
      "upload",
      "t3-apply",
      "t3-place",
      "upload",
      "t3-inputs",
      "stream",
      "t3-outputs",
      "download",
      "terminate",
    ]);
    expect(shipped).toEqual([input.slice(1)]);
    expect(fake.calls.find((call) => call.argv?.[3] === "t3-outputs")?.argv?.slice(4)).toEqual([
      "/",
      String(100 * 1024 * 1024),
      output,
      "/nowhere",
    ]);
    expect(NodeFS.readFileSync(NodePath.join(output, "report.json"), "utf8")).toBe("done\n");
    expect(seen.at(-1)).toBe("stderr [t3] Not found: /nowhere.\n");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

/** A gzip tar as a copy packs it from its root: each file at its own path, less the slash. */
const packedArchive = (
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
) => {
  const packed = tempDir("packed");
  for (const [path, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(packed, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(packed, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(packed, path)), { recursive: true });
    NodeFS.symlinkSync(target, NodePath.join(packed, path));
  }
  const top = NodeFS.readdirSync(packed);
  NodeChildProcess.execFileSync("tar", ["-czf", "out.tgz", ...top], { cwd: packed });
  return NodePath.join(packed, "out.tgz");
};

it.effect("outputs come back only whole and as asked, or leave the host as it was", () => {
  const { root, fake, layer, start } = setup();
  const output = NodePath.join(tempDir("outputs"), "run");
  const elsewhere = NodePath.join(tempDir("elsewhere"), "authorized_keys");
  NodeFS.mkdirSync(output);
  NodeFS.writeFileSync(NodePath.join(output, "stale.txt"), "old\n");
  const garbage = NodePath.join(tempDir("garbage"), "out.tgz");
  NodeFS.writeFileSync(garbage, "not a tar");
  return Effect.gen(function* () {
    fake.onExec(isStep("t3-outputs"), { exitCode: 0 });
    const forks = yield* start;
    const copyBack = (archive: string) =>
      Effect.gen(function* () {
        fake.downloadFrom(archive);
        const { seen, observer } = watcher();
        yield* forks.exec(request(root, { outputs: [output] }), observer);
        return seen.at(-1);
      });
    const untouched = () => {
      expect(NodeFS.readdirSync(output)).toEqual(["stale.txt"]);
      expect(NodeFS.existsSync(elsewhere)).toBe(false);
      expect(NodeFS.readdirSync(NodePath.dirname(output))).toEqual(["run"]);
    };

    expect(
      yield* copyBack(
        packedArchive({ [`${output}/report.json`]: "new\n", [elsewhere]: "ssh-ed25519 x\n" }),
      ),
    ).toBe(
      `stderr [t3] The outputs were not copied back: ${NodePath.dirname(elsewhere)} is not a requested output.\n`,
    );
    untouched();
    expect(yield* copyBack(packedArchive({}, { [`${output}/keys`]: elsewhere }))).toBe(
      `stderr [t3] The outputs were not copied back: ${output}/keys is not a plain file or directory.\n`,
    );
    untouched();
    expect(yield* copyBack(garbage)).toBe(
      "stderr [t3] The outputs were not copied back: Copying the outputs back failed.\n",
    );
    untouched();

    expect(yield* copyBack(packedArchive({ [`${output}/report.json`]: "new\n" }))).toBe(
      "started true",
    );
    // The output replaced its host path whole: the stale file went with the old directory.
    expect(NodeFS.readdirSync(output)).toEqual(["report.json"]);
    expect(NodeFS.readdirSync(NodePath.dirname(output))).toEqual(["run"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("a copy may not read or write T3 home, nor replace the home directory", () => {
  const { root, stateDir, fake, layer, start } = setup();
  const t3Home = NodePath.dirname(stateDir);
  return Effect.gen(function* () {
    const forks = yield* start;
    const cases: Array<readonly [Partial<ForkExecRequest>, RegExp]> = [
      [
        { inputs: [NodePath.join(stateDir, "settings.json")] },
        /T3 home, which a copy may not read/,
      ],
      [{ outputs: [NodePath.join(t3Home, "secrets")] }, /T3 home, which a copy may not write/],
      [{ outputs: [NodePath.dirname(t3Home)] }, /T3 home, which a copy may not write/],
      [{ outputs: ["/Users/me"] }, /home directory, which an output may not replace/],
    ];
    // macOS and Windows ignore case, so another spelling names the same T3 home there.
    const otherCase = NodePath.join(
      NodePath.dirname(t3Home),
      NodePath.basename(t3Home).toUpperCase(),
      "secrets",
    );
    if (!otherCase.startsWith(t3Home) && NodeFS.existsSync(NodePath.dirname(otherCase))) {
      cases.push([{ outputs: [otherCase] }, /T3 home, which a copy may not write/]);
    }
    for (const [overrides, message] of cases) {
      const outcome = yield* forks.exec(request(root, overrides), watcher().observer);
      expect(outcome._tag === "NotStarted" ? outcome.message : outcome._tag).toMatch(message);
    }
    expect(fake.calls.some((call) => call.op === "create")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

const capturedLogs = () => {
  const logs: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make(({ message }) => {
    logs.push(Array.isArray(message) ? message : [message]);
  });
  return { logs, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

it.effect("each finished copy logs its caller, command, size, exit code and phase times", () => {
  const { root, fake, layer, start } = setup();
  const { logs, layer: logging } = capturedLogs();
  const command = `API_TOKEN='s3cret value' bun test ${"packages/api ".repeat(20)}`;
  return Effect.gen(function* () {
    fake.onExec(isCommand(command), { exitCode: 3 });
    const forks = yield* start;
    let jobId = "";
    const shimmed = request(root, { command });
    yield* forks.exec(
      { ...shimmed, environment: { ...shimmed.environment, T3CODE_FORK_CALLER: "bun-shim" } },
      { started: (id) => Effect.sync(() => (jobId = id)), output: () => {} },
    );
    const finished = logs.filter(([text]) => text === "worktree fork job finished");
    expect(finished).toEqual([
      [
        "worktree fork job finished",
        {
          job: jobId,
          caller: "bun-shim",
          command: `API_TOKEN=… bun test ${"packages/api ".repeat(20)}`.slice(0, 159) + "…",
          repository: "acme/widgets",
          cpu: 8,
          memoryMiB: 16384,
          shippedBytes: expect.any(Number),
          exitCode: 3,
          timedOut: false,
          queuedMs: expect.any(Number),
          setupMs: expect.any(Number),
          commandMs: expect.any(Number),
        },
      ],
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, logging)));
});

it.effect("a copy that does not start logs its caller and command", () => {
  const { root, layer, start } = setup();
  const { logs, layer: logging } = capturedLogs();
  return Effect.gen(function* () {
    const forks = yield* start;
    yield* forks.exec(request(root, { size: "huge" }), watcher().observer);
    expect(logs.filter(([text]) => text === "worktree fork copy did not start")).toEqual([
      [
        "worktree fork copy did not start",
        expect.objectContaining({ cwd: root, caller: "fork-exec", command: "bun test" }),
      ],
    ]);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, logging)));
});

it.effect("a command past its timeout exits 124 and its copy ends", () => {
  const { root, fake, layer, start } = setup();
  return Effect.gen(function* () {
    fake.onExec(isCommand("bun test"), { exitCode: new Promise<number>(() => {}) });
    const forks = yield* start;
    const streaming = fake.next("stream");
    const { seen, observer } = watcher();
    const fiber = yield* forks
      .exec(request(root, { timeoutSeconds: 60, outputs: [`${root}/dist`] }), observer)
      .pipe(Effect.forkChild);
    yield* Effect.promise(() => streaming);
    yield* TestClock.adjust("60 seconds");
    expect(yield* Fiber.join(fiber)).toMatchObject({
      _tag: "Exited",
      exitCode: 124,
      timedOut: true,
    });
    expect(seen.at(-1)).toBe(
      "stderr [t3] The command timed out, so its outputs were not copied back.\n",
    );
    expect(fake.running().size).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("a caller that goes away ends its copy", () => {
  const { root, fake, layer, start } = setup();
  return Effect.gen(function* () {
    fake.onExec(isCommand("bun test"), { exitCode: new Promise<number>(() => {}) });
    const forks = yield* start;
    const { started, observer } = watcher();
    const fiber = yield* forks.exec(request(root), observer).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(fake.calls.at(-1)?.op).toBe("terminate");
    expect(fake.running().size).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect(
  "runs a batch in the thread's worktree, with logs on disk and outputs copied back",
  () => {
    const { root, fake, layer, start } = setup();
    const packed = tempDir("packed");
    NodeFS.mkdirSync(NodePath.join(packed, "coverage"));
    NodeFS.writeFileSync(NodePath.join(packed, "coverage", "lcov.info"), "TN:\n");
    NodeChildProcess.execFileSync("tar", ["-czf", "out.tgz", "coverage"], { cwd: packed });
    return Effect.gen(function* () {
      fake.onExec(isCommand("bun test --shard=1/2"), {
        exitCode: 0,
        chunks: [["stdout", "ok 1\n"]],
      });
      fake.onExec(isCommand("bun test --shard=2/2"), {
        exitCode: 1,
        chunks: [["stderr", "boom\n"]],
      });
      fake.onExec(isStep("t3-outputs"), { exitCode: 0, stdout: "missing.txt\0" });
      fake.downloadFrom(NodePath.join(packed, "out.tgz"));
      const forks = yield* start;
      const input: FleetForkRunInput = {
        jobs: [
          { command: "bun test --shard=1/2", outputs: ["coverage", "missing.txt"] },
          { command: "bun test --shard=2/2" },
        ],
      };
      const started = yield* forks.run(owner, input);
      expect(started.jobs.map((job) => job.state)).toEqual(["queued", "queued"]);
      const done = yield* forks.status(owner, { batchId: started.batchId, waitSeconds: 45 });

      expect(done.state).toBe("finished");
      const [first, second] = done.jobs;
      expect(first).toMatchObject({ state: "exited", exitCode: 0, stdoutTail: "ok 1\n" });
      expect(second).toMatchObject({ state: "exited", exitCode: 1, stderrTail: "boom\n" });
      const logs = first?.state === "exited" ? first.logsUri! : "";
      expect(NodeFS.readFileSync(NodePath.join(logs, "stdout.log"), "utf8")).toBe("ok 1\n");
      expect(first?.state === "exited" && first.outputsProblem).toBe("Not found: missing.txt.");
      const copiedTo = first?.state === "exited" ? first.copiedTo! : "";
      expect(NodeFS.readFileSync(NodePath.join(copiedTo, "coverage", "lcov.info"), "utf8")).toBe(
        "TN:\n",
      );
      // Both jobs ran in the same shipped state, in the thread's worktree.
      expect(fake.calls.filter((call) => call.op === "upload")).toHaveLength(2);
      expect(
        fake.calls
          .filter((call) => call.op === "stream")
          .map((call) => [call.workdir, call.env?.SERVER_ONLY]),
      ).toEqual([
        [root, "yes"],
        [root, "yes"],
      ]);
      expect(fake.running().size).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

it.effect("outputs over the copy-back limit stay in the copy, with the reason", () => {
  const { fake, layer, start } = setup();
  return Effect.gen(function* () {
    fake.onExec(isStep("t3-outputs"), { exitCode: 4, chunks: [["stderr", "209715200\n"]] });
    const forks = yield* start;
    const { batchId } = yield* forks.run(owner, { jobs: [{ command: "make", outputs: ["dist"] }] });
    const done = yield* forks.status(owner, { batchId, waitSeconds: 45 });
    expect(done.jobs[0]).toMatchObject({
      state: "exited",
      outputsProblem: "The outputs are 200 MiB compressed, over the 100 MiB copy-back limit.",
    });
    expect(done.jobs[0]).not.toHaveProperty("copiedTo");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("cancelling ends a running job's copy and keeps a queued one from starting", () => {
  const { fake, layer, start } = setup({ maxConcurrent: 1 });
  return Effect.gen(function* () {
    fake.onExec(isCommand("sleep 1000"), { exitCode: new Promise<number>(() => {}) });
    const forks = yield* start;
    const streaming = fake.next("stream");
    const { batchId } = yield* forks.run(owner, {
      jobs: [{ command: "sleep 1000" }, { command: "sleep 1000" }],
    });
    yield* Effect.promise(() => streaming);
    expect((yield* forks.status(owner, { batchId })).jobs.map((job) => job.state)).toEqual([
      "running",
      "queued",
    ]);
    yield* forks.cancel(owner, { batchId });
    const done = yield* forks.status(owner, { batchId, waitSeconds: 45 });
    expect(done).toMatchObject({
      state: "finished",
      jobs: [
        { index: 0, state: "cancelled" },
        { index: 1, state: "cancelled" },
      ],
    });
    expect(fake.calls.filter((call) => call.op === "create")).toHaveLength(1);
    expect(fake.running().size).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("fork-exec and batches share the host's copies first come, first served", () => {
  const { root, fake, layer, start } = setup({ maxConcurrent: 1 });
  return Effect.gen(function* () {
    const first = gate<number>();
    fake.onExec(isCommand("bun test"), { exitCode: first.value });
    const forks = yield* start;
    const { started, observer } = watcher();
    const exec = yield* forks.exec(request(root), observer).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const { batchId } = yield* forks.run(owner, { jobs: [{ command: "make" }] });
    expect(fake.calls.filter((call) => call.op === "create")).toHaveLength(1);
    first.open(0);
    yield* Fiber.join(exec);
    const done = yield* forks.status(owner, { batchId, waitSeconds: 45 });
    expect(done.jobs[0]).toMatchObject({ state: "exited", exitCode: 0 });
    expect(fake.calls.filter((call) => call.op === "create")).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("refuses bad batches, a fifth running batch, and another thread's batch", () => {
  const { fake, layer, start } = setup();
  return Effect.gen(function* () {
    fake.onExec(isCommand("sleep 1000"), { exitCode: new Promise<number>(() => {}) });
    const forks = yield* start;
    const refused = (input: FleetForkRunInput) =>
      forks.run(owner, input).pipe(
        Effect.flip,
        Effect.map((error) => error.code),
      );
    expect(yield* refused({ jobs: [{ command: "make", cwd: "relative/dir" }] })).toBe(
      "invalid_request",
    );
    expect(yield* refused({ jobs: [{ command: "make", outputs: ["../up"] }] })).toBe(
      "invalid_request",
    );
    expect(yield* refused({ jobs: [{ command: "make", size: "huge" }] })).toBe("invalid_request");
    let batchId = "";
    for (let count = 0; count < 4; count += 1)
      batchId = (yield* forks.run(owner, { jobs: [{ command: "sleep 1000" }] })).batchId;
    expect(yield* refused({ jobs: [{ command: "make" }] })).toBe("invalid_request");
    const stranger = yield* forks
      .status(ThreadId.make("thread-other"), { batchId })
      .pipe(Effect.flip);
    expect(stranger.code).toBe("invalid_request");
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("the sweep ends this host's sandboxes no job owns, and nothing else", () => {
  const { root, fake, layer, start } = setup();
  return Effect.gen(function* () {
    fake.onExec(isCommand("bun test"), { exitCode: new Promise<number>(() => {}) });
    const forks = yield* start;
    const { started, observer } = watcher();
    yield* forks.exec(request(root), observer).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const [running] = fake.running();
    const elsewhere = fake.plant({ purpose: "t3-worktree-fork", host: "env-other", job: "x" });
    const orphan = fake.plant({ purpose: "t3-worktree-fork", host: "env-host", job: "gone" });
    const swept = fake.next("terminate");
    yield* TestClock.adjust("10 minutes");
    expect((yield* Effect.promise(() => swept)).sandboxId).toBe(orphan);
    expect(fake.running()).toEqual(new Set([running, elsewhere]));
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("a host without worktree-forks.json, or a cloud box, has no backend", () =>
  Effect.gen(function* () {
    const { root, stateDir, layer } = setup();
    const forksOf = (environment: NodeJS.ProcessEnv) =>
      WorktreeForks.WorktreeForks.pipe(
        Effect.provide(
          WorktreeForks.layer.pipe(
            Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
            Layer.provide(layer),
          ),
        ),
      );
    const none = yield* forksOf({});
    expect(none.enabled).toBe(false);
    expect((yield* none.exec(request(root), watcher().observer))._tag).toBe("NotStarted");
    expect((yield* none.run(owner, { jobs: [{ command: "make" }] }).pipe(Effect.flip)).code).toBe(
      "environment_unavailable",
    );
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "worktree-forks.json"),
      JSON.stringify({
        modal: { tokenId: "ak", tokenSecret: "as", imageId: "im" },
        repositories: [],
      }),
    );
    expect((yield* forksOf({ T3CODE_USAGE_HOST_ID: "host" })).enabled).toBe(false);
  }).pipe(Effect.scoped),
);
