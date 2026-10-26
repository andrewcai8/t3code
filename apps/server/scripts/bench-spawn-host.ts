// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalConsoleInEffect:off preferSchemaOverJson:off - a standalone benchmark that reads process memory and prints its report as JSON lines.
/**
 * Times how long starting a child process blocks the event loop, spawning directly versus through
 * the spawn host, with this process inflated to a server-like RSS.
 * Usage: node apps/server/scripts/bench-spawn-host.ts [--rss-mb 1536] [--rounds 5] [--sequential 30] [--burst 100]
 * Only Linux with libuv < 1.53 matters; on macOS, Node does not fork the caller.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as ProcessRunner from "../src/processRunner.ts";
import * as SpawnHost from "../src/process/SpawnHost.ts";

const { values: flags } = NodeUtil.parseArgs({
  options: {
    "rss-mb": { type: "string", default: "1536" },
    rounds: { type: "string", default: "5" },
    sequential: { type: "string", default: "30" },
    burst: { type: "string", default: "100" },
  },
});
const targetRssMb = Number(flags["rss-mb"]);
const rounds = Number(flags.rounds);
const sequentialSpawns = Number(flags.sequential);
const burstSize = Number(flags.burst);

const GIT_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["rev-parse", "--git-dir"],
  ["symbolic-ref", "--quiet", "HEAD"],
  ["config", "--get", "user.name"],
  ["remote"],
  ["for-each-ref", "--format=%(refname)", "refs/heads"],
  ["status", "--porcelain"],
];

const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bench-spawn-host-"));
const git = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
git("init", "-q", "-b", "main");
git("config", "user.name", "bench");
git("config", "user.email", "bench@example.com");
NodeFS.writeFileSync(NodePath.join(repo, "file.txt"), "hello\n");
git("add", ".");
git("commit", "-q", "-m", "init");

const rssMb = () => process.memoryUsage().rss / 2 ** 20;
const mappings = () => {
  try {
    return NodeFS.readFileSync("/proc/self/maps", "utf8").split("\n").length - 1;
  } catch {
    return undefined;
  }
};

const ballast: Array<unknown> = [];
const inflate = (megabytes: number) => {
  // Mix V8 heap pages and native buffers of varied sizes, like a long-lived server.
  const heapMb = Math.round(megabytes * 0.35);
  for (let mb = 0; mb < heapMb; mb++) {
    ballast.push(Array.from({ length: 8_192 }, (_, index) => ({ index, label: `item-${index}` })));
    if (rssMb() >= megabytes) return;
  }
  const sizes = [64 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
  for (let index = 0; rssMb() < megabytes; index++) {
    const buffer = Buffer.allocUnsafe(sizes[index % sizes.length]!);
    buffer.fill(index & 0xff);
    ballast.push(buffer);
  }
};

const histogramMs = (histogram: NodePerfHooks.IntervalHistogram) => ({
  p50: histogram.percentile(50) / 1e6,
  p90: histogram.percentile(90) / 1e6,
  p99: histogram.percentile(99) / 1e6,
  max: histogram.max / 1e6,
});

const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted.at(-1)! };
};

type Mode = "direct" | "hosted";

const runGit = (runner: ProcessRunner.ProcessRunner["Service"], index: number) =>
  runner.run({ command: "git", args: GIT_COMMANDS[index % GIT_COMMANDS.length]!, cwd: repo });

/**
 * Each spawn alone, with the longest event-loop stall seen while it ran. Without a runner,
 * the same measurement around a 3 ms sleep: the floor of this method.
 */
const sequentialRound = Effect.fn("benchSpawnHost.sequentialRound")(function* (
  runner: ProcessRunner.ProcessRunner["Service"] | undefined,
) {
  const stalls: Array<number> = [];
  let failures = 0;
  for (let index = 0; index < sequentialSpawns; index++) {
    const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    // The histogram drops its first sample; a stall before its second tick would go unseen.
    yield* Effect.sleep("5 millis");
    if (runner === undefined) {
      yield* Effect.sleep("3 millis");
    } else {
      const result = yield* Effect.exit(runGit(runner, index));
      if (Exit.isFailure(result) || result.value.code !== 0) failures++;
    }
    histogram.disable();
    stalls.push(histogram.max / 1e6);
  }
  return { stalls, failures };
});

/** A burst of concurrent git commands, like a sidebar refresh of many worktrees. */
const burstRound = Effect.fn("benchSpawnHost.burstRound")(function* (
  runner: ProcessRunner.ProcessRunner["Service"],
) {
  const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  const startedAt = performance.now();
  const results = yield* Effect.forEach(
    Array.from({ length: burstSize }, (_, index) => index),
    (index) => Effect.exit(runGit(runner, index)),
    { concurrency: "unbounded" },
  );
  const wallMs = performance.now() - startedAt;
  histogram.disable();
  const failures = results.filter(
    (result) => Exit.isFailure(result) || result.value.code !== 0,
  ).length;
  return { wallMs, delay: histogramMs(histogram), failures };
});

const rawForkMs = () => {
  const samples: Array<number> = [];
  for (let index = 0; index < 20; index++) {
    const startedAt = performance.now();
    const child = NodeChildProcess.spawn("true", [], { stdio: "ignore", detached: true });
    samples.push(performance.now() - startedAt);
    child.unref();
  }
  return quantiles(samples);
};

const hostCommand = {
  command: process.execPath,
  args: [NodeURL.fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "__spawn-host"],
};

const program = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const buildRunner = (spawner: typeof NodeChildProcessSpawner.layer) =>
    Layer.buildWithScope(
      ProcessRunner.layer.pipe(Layer.provide(spawner), Layer.provide(NodeServices.layer)),
      scope,
    ).pipe(Effect.map(Context.get(ProcessRunner.ProcessRunner)));
  // The host is forked here, before inflation, as the server forks it at startup.
  const startRss = rssMb();
  const hostedRunner = yield* buildRunner(SpawnHost.layerHosted(hostCommand));
  const directRunner = yield* buildRunner(NodeChildProcessSpawner.layer);

  const hostPid = Number(
    (yield* hostedRunner.run({ command: "sh", args: ["-c", "echo $PPID"] })).stdout.trim(),
  );
  const hostRssMb =
    hostPid === process.pid
      ? undefined
      : Number(
          NodeChildProcess.execFileSync("ps", ["-o", "rss=", "-p", String(hostPid)], {
            encoding: "utf8",
          }),
        ) / 1024;

  inflate(targetRssMb);
  const platform = yield* HostProcess.Platform;
  const environment = {
    platform,
    arch: yield* HostProcess.Architecture,
    node: process.versions.node,
    libuv: process.versions.uv,
    spawnsThroughHost: SpawnHost.spawnsThroughHost(platform, process.versions.uv),
    cpus: NodeOS.cpus().length,
    loadavg: NodeOS.loadavg().map((load) => Number(load.toFixed(2))),
    startRssMb: Math.round(startRss),
    inflatedRssMb: Math.round(rssMb()),
    mappings: mappings(),
    hostPid,
    hostIsSeparateProcess: hostPid !== process.pid,
    hostRssMb: hostRssMb === undefined ? undefined : Math.round(hostRssMb),
    rawForkMsAtInflatedRss: rawForkMs(),
  };
  console.log(JSON.stringify({ environment }));

  const runners: Record<Mode, ProcessRunner.ProcessRunner["Service"]> = {
    direct: directRunner,
    hosted: hostedRunner,
  };
  type Burst = Effect.Success<ReturnType<typeof burstRound>>;
  const results: Record<Mode, { stalls: Array<number>; bursts: Array<Burst>; failures: number }> = {
    direct: { stalls: [], bursts: [], failures: 0 },
    hosted: { stalls: [], bursts: [], failures: 0 },
  };
  // Warm both paths before measuring.
  yield* sequentialRound(directRunner);
  yield* sequentialRound(hostedRunner);
  for (let round = 0; round < rounds; round++) {
    for (const mode of ["direct", "hosted"] as const) {
      const sequential = yield* sequentialRound(runners[mode]);
      const burst = yield* burstRound(runners[mode]);
      results[mode].stalls.push(...sequential.stalls);
      results[mode].bursts.push(burst);
      results[mode].failures += sequential.failures + burst.failures;
      console.log(
        JSON.stringify({ round, mode, burst, sequentialStallMs: quantiles(sequential.stalls) }),
      );
    }
  }
  const idle = yield* sequentialRound(undefined);
  console.log(JSON.stringify({ summary: "idle floor", perSpawnStallMs: quantiles(idle.stalls) }));
  for (const mode of ["direct", "hosted"] as const) {
    const bursts = results[mode].bursts;
    console.log(
      JSON.stringify({
        summary: mode,
        perSpawnStallMs: quantiles(results[mode].stalls),
        burstMaxDelayMs: quantiles(bursts.map((burst) => burst.delay.max)),
        burstP99DelayMs: quantiles(bursts.map((burst) => burst.delay.p99)),
        burstWallMs: quantiles(bursts.map((burst) => burst.wallMs)),
        failures: results[mode].failures,
      }),
    );
  }
  yield* Scope.close(scope, Exit.void);
});

await Effect.runPromise(program).finally(() => {
  NodeFS.rmSync(repo, { recursive: true, force: true });
});
