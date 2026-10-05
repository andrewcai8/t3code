// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalFetchInEffect:off - this test writes private manager config and drives a local guest.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  EnvironmentControlError,
  EnvironmentId,
  type EnvironmentProvisionUpgradeResult,
  ProvisionRequestId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { makeE2bProvisionRuntime } from "./E2bProvisionRuntime.ts";
import {
  EnvironmentControl,
  layer,
  recoverRefusedResume,
  upgradeAfterResume,
} from "./EnvironmentControl.ts";
import { ProvisionPreparationManifest, provisionDigest } from "./ProvisionPreparation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { freePort, localPort, world, type Cleanups } from "./guestTestFixture.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest);
const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  info: null as null | Record<string, unknown>,
}));

// One E2B sandbox that runs its commands on this machine, so a resume drives
// the real guest preparation against a real (fixture) T3 server.
vi.mock("e2b", async (importOriginal) => {
  const actual = await importOriginal<typeof import("e2b")>();
  const NodeChildProcess = await import("node:child_process");
  const start = (command: string) => {
    const child = NodeChildProcess.spawn("sh", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => (stdout += data));
    child.stderr.setEncoding("utf8").on("data", (data: string) => (stderr += data));
    const done = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) =>
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr })),
    );
    return { child, done };
  };
  const sandbox = {
    commands: {
      run: async (command: string, options?: { readonly background?: boolean }) => {
        const { child, done } = start(command);
        if (!options?.background) {
          child.stdin.end();
          return done;
        }
        return {
          sendStdin: async (data: string) => void child.stdin.write(data),
          closeStdin: async () => void child.stdin.end(),
          wait: () => done,
          disconnect: async () => {},
        };
      },
    },
    setTimeout: async () => {},
    getHost: (port: number) => `${port}-sandbox-1.e2b.app`,
    // envd's upload endpoint, writing where the guest reads since the guest is this machine.
    uploadUrl: async (path: string) => {
      const NodeHttp = await import("node:http");
      const NodeFS = await import("node:fs");
      await NodeFS.promises.mkdir((await import("node:path")).dirname(path), { recursive: true });
      const server = NodeHttp.createServer((request, response) => {
        const file = NodeFS.createWriteStream(path);
        request.pipe(file);
        file.on("finish", () => {
          response.end();
          server.close();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      return `http://127.0.0.1:${port}/`;
    },
  };
  class E2B {
    Sandbox = { getInfo: async () => mocks.info, connect: async () => sandbox };
  }
  return { ...actual, E2B };
});
// The guest's descriptor at its E2B public host, read from the port it really listens on.
vi.mock("./leaseActivity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./leaseActivity.ts")>();
  return {
    ...actual,
    readGuestProtocol: (origin: string) =>
      actual.readGuestProtocol(
        origin.replace(/^https:\/\/(\d+)-sandbox-1\.e2b\.app$/, "http://127.0.0.1:$1"),
      ),
  };
});
vi.mock("./driver.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./driver.ts")>();
  return {
    ...actual,
    createCloudDriver: (...args: Parameters<typeof actual.createCloudDriver>) => ({
      ...actual.createCloudDriver(...args),
      resume: mocks.wake,
    }),
  };
});

const requestId = ProvisionRequestId.make("0b0f7f61-8a52-4f6c-9d0b-6f3a2a8d3c11");

/**
 * A paused lease on an E2B box this manager prepared, whose guest preparation
 * ran for real and left its T3 server listening on `port`.
 */
const pausedPreparedBox = (input: {
  readonly follow: boolean;
  /** The host pins a newer build than the one the box was made with. */
  readonly pinnedRevision?: string;
}) =>
  Effect.gen(function* () {
    const cleanups: Cleanups = [];
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const w = yield* Effect.promise(() => world(cleanups));
    const pinned =
      input.pinnedRevision === undefined
        ? undefined
        : yield* Effect.promise(async () => {
            const bundle = NodePath.join(w.base, "pinned-bundle");
            await NodeFSP.mkdir(bundle);
            await NodeFSP.copyFile(w.archivePath, NodePath.join(w.base, "pinned.tar"));
            await NodeFSP.writeFile(NodePath.join(bundle, "NEWER"), "newer build\n");
            NodeChildProcess.execFileSync("tar", [
              "-rf",
              NodePath.join(w.base, "pinned.tar"),
              "-C",
              bundle,
              "NEWER",
            ]);
            const path = NodePath.join(w.base, "pinned.tar");
            return {
              path,
              sha256: NodeCrypto.createHash("sha256")
                .update(await NodeFSP.readFile(path))
                .digest("hex"),
              revision: input.pinnedRevision!,
              entrypoint: "cli.mjs",
              runtimeExecutable: process.execPath,
            };
          });
    const configPath = NodePath.join(w.base, "environment-control.json");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        configPath,
        encodeJson({
          e2bApiKey: "test-key",
          broker: {
            sandboxId: "unused",
            metadata: { owner: "fixture" },
            url: "https://unused.invalid",
            ingressKey: "unused",
          },
          targets: [],
          ...(pinned ? { provisioning: { runtimeArtifacts: { linux: pinned } } } : {}),
        }),
      ),
    );
    vi.stubEnv("T3CODE_ENVIRONMENT_CONTROL_CONFIG", configPath);
    const port = yield* Effect.promise(freePort);
    const artifact = {
      archivePath: w.archivePath,
      sha256: w.runtimeSha256,
      revision: "c".repeat(40),
      entrypoint: "cli.mjs",
    };
    const sourceRevision = w.head();
    const preparation = {
      requestId,
      root: w.root,
      repository: { url: w.origin, revision: sourceRevision },
      artifact,
      runtimeExecutable: process.execPath,
      port,
      readinessTimeoutSeconds: 10,
      brokerTtl: "1h",
      files: [],
    };
    const preparationHash = provisionDigest(stableStringify({ preparation, egressAllow: [] }));
    const manifest = decodeManifest({
      input: {
        requestId,
        provider: "e2b",
        providerInstanceId: "codex",
        repository: "owner/repo",
        ...(input.follow ? { branch: "main" } : { sourceRevision }),
      },
      request: {
        requestId,
        provider: "e2b",
        templateId: "template",
        strategy: "direct",
        providerInstanceId: "codex",
        repository: "owner/repo",
        sourceRevision,
        preparationHash,
      },
      preparation,
      localArtifact: { path: w.archivePath, ...artifact, runtimeExecutable: process.execPath },
      egressAllow: [],
    });
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ProvisionOperationStore;
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(NodePath.join(stateDir, "provisioning"), {
        recursive: true,
        mode: 0o700,
      });
      await NodeFSP.writeFile(
        NodePath.join(stateDir, "provisioning", `${requestId}.json`),
        encodeJson(manifest),
        { mode: 0o600 },
      );
    });
    const operation = yield* store.accept(manifest.request);
    mocks.info = {
      sandboxId: "sandbox-1",
      templateId: "template",
      metadata: {
        provision_request_id: requestId,
        provision_request_hash: operation.requestHash,
        preparation_hash: preparationHash,
        account: "codex",
      },
    };
    const prepared = yield* Effect.promise(() =>
      makeE2bProvisionRuntime({ apiKey: "test-key" }).prepare(operation, "sandbox-1", manifest),
    );
    const readiness = {
      environmentId: EnvironmentId.make(prepared.environmentId),
      projectDir: prepared.projectDir,
      sourceRevision,
      preparationHash,
      t3Revision: prepared.t3Revision,
      artifactSha256: prepared.artifactSha256,
    };
    yield* store.advance(operation, {
      kind: "ready",
      allocation: { kind: "direct", resource: { provider: "e2b", sandboxId: "sandbox-1" } },
      readiness,
    });
    const registry = createProvisionedLeaseRegistry(sql);
    yield* Effect.promise(async () => {
      await registry.register({
        leaseId: requestId,
        sandboxId: "sandbox-1",
        provider: "e2b",
        providerInstanceId: "codex",
      });
      await registry.claim({
        leaseId: requestId,
        owner: { environmentId: readiness.environmentId, threadId: "thread" },
      });
      // Attach recorded where the host reaches the box.
      await registry.markActive({
        leaseId: requestId,
        remoteAccess: {
          origin: `https://${port}-sandbox-1.e2b.app`,
          brokerToken: "test-private-broker",
        },
      });
      await registry.markPaused(requestId);
    });
    mocks.wake.mockResolvedValue({});
    return {
      w,
      port,
      environmentId: readiness.environmentId,
      leaseState: () =>
        Effect.promise(() => registry.findById(requestId)).pipe(
          Effect.map((lease) => lease?.state),
        ),
      /** The build the host records the box running. */
      runningRevision: () =>
        store
          .get(requestId)
          .pipe(
            Effect.map((current) =>
              current.state.kind === "ready" ? current.state.readiness.t3Revision : null,
            ),
          ),
      /** Makes the guest's T3 server report it speaks `version` of the orchestration protocol. */
      speaksProtocol: (version: number) =>
        Effect.promise(async () => {
          const home = NodePath.dirname(
            NodePath.dirname(
              NodeChildProcess.execFileSync("find", [w.root, "-name", "environment-id"], {
                encoding: "utf8",
              })
                .trim()
                .split("\n")[0]!,
            ),
          );
          await NodeFSP.writeFile(NodePath.join(home, "orchestration-protocol"), String(version));
        }),
      /** Kills the guest's T3 server and waits until it has let go of its lock. */
      killServer: () =>
        Effect.promise(async () => {
          process.kill(prepared.serverPid, "SIGKILL");
          const released = await localPort.executePython({
            script:
              "import fcntl,sys\nwith open(sys.stdin.read(), 'a') as lock: fcntl.flock(lock, fcntl.LOCK_EX)",
            stdin: NodePath.join(w.root, "server.lock"),
          });
          expect(released.exitCode).toBe(0);
        }),
      /** The environment the guest's T3 port answers as. */
      answeringEnvironment: () =>
        Effect.promise(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/.well-known/t3/environment`);
          return ((await response.json()) as { environmentId: string }).environmentId;
        }),
    };
  });

/** Runs `body` against a manager whose state lives in a fresh directory. */
const withManager = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "e2b-resume-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    return yield* body.pipe(
      Effect.provide(
        Layer.merge(layer, ProvisionOperationStore.layer).pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(makeProviderRegistryLayer()),
          Layer.provideMerge(ServerConfig.layerTest(directory, directory)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped);

it.effect("brings back a woken box whose T3 server died while its sandbox stayed up", () =>
  withManager(
    Effect.gen(function* () {
      const box = yield* pausedPreparedBox({ follow: false });
      yield* box.killServer();
      const manager = yield* EnvironmentControl;

      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "resumed",
      });
      expect(yield* box.answeringEnvironment()).toBe(box.environmentId);
      expect(yield* box.leaseState()).toBe("active");
    }),
  ),
);

it.effect("asks to wake a box whose T3 server died under an active lease, then pairs it", () =>
  withManager(
    Effect.gen(function* () {
      const box = yield* pausedPreparedBox({ follow: false });
      const manager = yield* EnvironmentControl;
      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "resumed",
      });
      yield* box.killServer();

      expect(yield* manager.attach({ requestId })).toEqual({
        kind: "refused",
        reason: "not-serving",
        message: "This chat's cloud machine is not serving. Wake it first.",
      });
      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "resumed",
      });
      expect(yield* manager.attach({ requestId })).toEqual({
        kind: "attached",
        environmentId: box.environmentId,
        pairingUrl: `https://${box.port}-sandbox-1.e2b.app/pair#token=pair-credential`,
      });
    }),
  ),
);

it.effect("keeps a woken box resumed when its followed branch cannot be fetched", () =>
  withManager(
    Effect.gen(function* () {
      const box = yield* pausedPreparedBox({ follow: true });
      yield* Effect.promise(() =>
        NodeFSP.rename(NodePath.join(box.w.base, "origin.git"), NodePath.join(box.w.base, "gone")),
      );
      const manager = yield* EnvironmentControl;

      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "resumed",
      });
      expect(yield* box.answeringEnvironment()).toBe(box.environmentId);
      expect(yield* box.leaseState()).toBe("active");
    }),
  ),
);

it.effect("refuses a box whose T3 server cannot start again, and leaves it to the reaper", () =>
  withManager(
    Effect.gen(function* () {
      const box = yield* pausedPreparedBox({ follow: false });
      yield* box.killServer();
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(box.w.root, "artifact", "cli.mjs")));
      const manager = yield* EnvironmentControl;

      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "refused",
        reason: "unknown",
        message: "The workspace could not be reconnected. Retry shortly.",
      });
      expect(yield* box.leaseState()).toBe("active");
    }),
  ),
);

it.effect("moves a woken box onto the build the host pins before anyone connects", () =>
  withManager(
    Effect.gen(function* () {
      const pinnedRevision = "e".repeat(40);
      const box = yield* pausedPreparedBox({ follow: false, pinnedRevision });
      const manager = yield* EnvironmentControl;

      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "resumed",
      });
      expect(
        yield* manager.upgrade({
          leaseId: requestId,
          sandboxId: "sandbox-1",
          environmentId: box.environmentId,
        }),
      ).toEqual({ kind: "current", t3Revision: pinnedRevision });
      expect(yield* box.answeringEnvironment()).toBe(box.environmentId);
    }),
  ),
);

it.effect("connects a woken box on its own build when it speaks the host's protocol", () =>
  withManager(
    Effect.gen(function* () {
      const box = yield* pausedPreparedBox({ follow: false, pinnedRevision: "e".repeat(40) });
      yield* box.speaksProtocol(2);
      const manager = yield* EnvironmentControl;

      expect(yield* manager.resume({ environmentId: box.environmentId })).toEqual({
        kind: "resumed",
      });
      expect(yield* box.runningRevision()).toBe("c".repeat(40));
      expect(yield* box.answeringEnvironment()).toBe(box.environmentId);
    }),
  ),
);

it.effect("waits out another caller's upgrade of a woken box, then reports it resumed", () =>
  Effect.gen(function* () {
    const answers: Array<EnvironmentProvisionUpgradeResult> = [
      { kind: "refused", reason: "busy", message: "This workspace is already being upgraded." },
      { kind: "current", t3Revision: "e".repeat(40) },
    ];
    const resumed = yield* upgradeAfterResume(Effect.sync(() => answers.shift()!)).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("2 seconds");

    expect(yield* Fiber.join(resumed)).toEqual({ kind: "resumed" });
    expect(answers).toEqual([]);
  }),
);

it.effect("refuses a woken box its upgrade left behind the pinned build", () =>
  Effect.gen(function* () {
    expect(
      yield* upgradeAfterResume(
        Effect.fail(
          new EnvironmentControlError({
            message: "Cloud provisioning could not be reconciled. Retry the same request.",
          }),
        ),
      ),
    ).toEqual({
      kind: "refused",
      reason: "unknown",
      message: "Cloud provisioning could not be reconciled. Retry the same request.",
    });
    expect(
      yield* upgradeAfterResume(
        Effect.succeed({
          kind: "refused",
          reason: "unknown",
          message: "This workspace could not be found. Upgrade was refused.",
        }),
      ),
    ).toEqual({
      kind: "refused",
      reason: "unknown",
      message: "This workspace could not be found. Upgrade was refused.",
    });
    expect(
      yield* upgradeAfterResume(
        Effect.succeed({
          kind: "refused",
          reason: "unconfigured",
          message: "Configure a pinned runtime artifact for this cloud platform before upgrading.",
        }),
      ),
    ).toEqual({ kind: "resumed" });
  }),
);

it.effect("recovers a box whose guest cannot start by upgrading it onto the pinned build", () =>
  Effect.gen(function* () {
    const stuck = {
      kind: "refused" as const,
      reason: "unknown" as const,
      message: "The workspace could not be reconnected. Retry shortly.",
    };
    expect(
      yield* recoverRefusedResume(
        stuck,
        Effect.succeed({ kind: "upgraded", t3Revision: "f".repeat(40) }),
      ),
    ).toEqual({ kind: "resumed" });
    expect(
      yield* recoverRefusedResume(
        stuck,
        Effect.succeed({ kind: "current", t3Revision: "f".repeat(40) }),
      ),
    ).toEqual(stuck);
    expect(
      yield* recoverRefusedResume(
        stuck,
        Effect.fail(new EnvironmentControlError({ message: "E2B can't place this machine." })),
      ),
    ).toEqual(stuck);
    const missing = {
      kind: "refused" as const,
      reason: "missing" as const,
      message: "This workspace is gone.",
    };
    expect(
      yield* recoverRefusedResume(
        missing,
        Effect.succeed({ kind: "upgraded", t3Revision: "f".repeat(40) }),
      ),
    ).toEqual(missing);
  }),
);
