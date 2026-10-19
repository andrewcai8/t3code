import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ScheduledCloudFire } from "./ScheduledCloudFire.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const taskInput = (title: string, target?: "local" | "e2b" | "modal") =>
  decodeUpsertInput({
    title,
    prompt: `Run ${title}.`,
    enabled: true,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: "project-cloud",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(target ? { target } : {}),
  });

it.effect("fires a cloud task on a machine without holding the caller, and a local one here", () =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    const fired = yield* Ref.make<ReadonlyArray<{ title: string; provider: string }>>([]);
    const fireStarted = yield* Deferred.make<void>();
    const releaseFire = yield* Deferred.make<void>();
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Scheduler.layer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Ref.update(launched, (titles) => [...titles, input.title]).pipe(
            Effect.as({ threadId: "thread-local" } as never),
          ),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(ScheduledCloudFire, {
        providers: Effect.succeed(["e2b"] as const),
        fire: ({ task, provider }) =>
          Ref.update(fired, (calls) => [...calls, { title: task.title, provider }]).pipe(
            Effect.andThen(Deferred.succeed(fireStarted, undefined)),
            Effect.andThen(Deferred.await(releaseFire)),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const cloud = (yield* service.upsert(taskInput("cloud", "e2b"))).task;
      const local = (yield* service.upsert(taskInput("local"))).task;
      assert.equal(cloud.target, "e2b");
      assert.equal(local.target, "local");

      // An edit that omits the target, as an agent's update does, keeps it.
      const { target: _target, ...withoutTarget } = taskInput("cloud renamed", "e2b");
      const renamed = yield* service.upsert({ ...withoutTarget, id: cloud.id });
      assert.equal(renamed.task.target, "e2b");

      yield* service.runNow({ id: cloud.id });
      yield* Deferred.await(fireStarted);
      const running = (yield* service.list()).tasks.find((task) => task.id === cloud.id);
      assert.equal(running?.lastRunStatus, "running");

      yield* service.runNow({ id: local.id });
      assert.deepEqual(yield* Ref.get(launched), ["local"]);

      const settled = service.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((task) => task.id === cloud.id)),
        Stream.filter((task) => task?.lastRunStatus === "succeeded"),
        Stream.runHead,
      );
      yield* Deferred.succeed(releaseFire, undefined);
      const done = yield* settled;
      assert.equal(done._tag === "Some" ? done.value?.runCount : undefined, 1);
      assert.deepEqual(yield* Ref.get(fired), [{ title: "cloud renamed", provider: "e2b" }]);
      assert.deepEqual(yield* Ref.get(launched), ["local"]);

      const bound = yield* service
        .upsert({ ...taskInput("bound", "e2b"), threadId: "thread-1" as never })
        .pipe(Effect.flip);
      assert.equal(bound.message, "A task that runs on a cloud machine must start a new chat.");
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const dependenciesWith = (
  fire: (typeof ScheduledCloudFire)["Service"]["fire"],
  providers: (typeof ScheduledCloudFire)["Service"]["providers"] = Effect.succeed(["e2b"]),
) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    Scheduler.layer,
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    Layer.succeed(ScheduledCloudFire, { providers, fire }),
  );

/** A host started with T3CODE_LOCAL_AGENT_RUNS=false. */
const layerCloudOnlyHostConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (config) => ({ ...config, localAgentRuns: false })),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-scheduled-cloud-only-" })),
  Layer.provide(NodeServices.layer),
);

const cloudOnlyHostService = (providers: ReadonlyArray<"e2b" | "modal">) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(dependenciesWith(() => Effect.void, Effect.succeed(providers))),
    Layer.provide(layerCloudOnlyHostConfig),
    Layer.provide(SqlitePersistence.layerMemory),
  );

it.effect("runs a new task on a host that runs no agents on its first cloud machine kind", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    assert.equal((yield* service.upsert(taskInput("default"))).task.target, "e2b");
    assert.equal((yield* service.upsert(taskInput("chosen", "modal"))).task.target, "modal");

    const local = yield* service.upsert(taskInput("local", "local")).pipe(Effect.flip);
    assert.equal(
      local.message,
      "This server does not run agents. Run the task on a cloud machine.",
    );
    assert.deepEqual((yield* service.list()).tasks.map((task) => task.title).toSorted(), [
      "chosen",
      "default",
    ]);
  }).pipe(Effect.provide(cloudOnlyHostService(["e2b", "modal"]))),
);

it.effect("keeps a new task here on a host that runs no agents and has no cloud machine", () =>
  Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    assert.equal((yield* service.upsert(taskInput("default"))).task.target, "local");
  }).pipe(Effect.provide(cloudOnlyHostService([]))),
);

it.effect("refuses to run a cloud task that is already running, as it does a local one", () =>
  Effect.gen(function* () {
    const fireStarted = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const cloud = (yield* service.upsert(taskInput("cloud", "e2b"))).task;
      yield* service.runNow({ id: cloud.id });
      yield* Deferred.await(fireStarted);
      const again = yield* service.runNow({ id: cloud.id }).pipe(Effect.flip);
      assert.equal(again.message, "Could not run schedule task.");
      assert.equal(
        (again.cause as { readonly message?: string } | undefined)?.message,
        "Schedule task is already running.",
      );
    }).pipe(
      Effect.provide(
        ScheduledTaskService.layer.pipe(
          Layer.provide(
            dependenciesWith(() =>
              Deferred.succeed(fireStarted, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("settles a cloud fire cut short by shutdown from the same request after a restart", () =>
  Effect.gen(function* () {
    const fires = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const fireStarted = yield* Deferred.make<void>();
    const dependencies = dependenciesWith(({ fireKey, firedAt }) =>
      Ref.modify(fires, (calls) => [calls.length, [...calls, { fireKey, firedAt }]]).pipe(
        // The first fire is still provisioning when the server stops; the host finishes it.
        Effect.flatMap((attempt) =>
          attempt === 0
            ? Deferred.succeed(fireStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        ),
      ),
    );
    const serverLayer = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));

    const taskId = yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      const cloud = (yield* tasks.upsert(taskInput("cloud", "e2b"))).task;
      yield* tasks.runNow({ id: cloud.id });
      yield* Deferred.await(fireStarted);
      return cloud.id;
    }).pipe(Effect.provide(serverLayer));

    const settled = yield* Effect.gen(function* () {
      const tasks = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* tasks.subscribeList().pipe(
        Stream.map(({ tasks }) => tasks.find((task) => task.id === taskId)),
        Stream.filter((task) => task !== undefined && task.lastRunStatus !== "running"),
        Stream.runHead,
      );
    }).pipe(Effect.provide(serverLayer));

    const task = Option.getOrThrow(settled);
    assert.equal(task?.lastRunStatus, "succeeded");
    assert.equal(task?.lastRunError, null);
    assert.equal(task?.runCount, 1);
    const [first, resumed] = yield* Ref.get(fires);
    assert.deepEqual(resumed, first);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
