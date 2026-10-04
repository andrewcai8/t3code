import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { ScheduledCloudFire } from "./ScheduledCloudFire.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const decodeUpsertInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const taskInput = (title: string, target?: "local" | "e2b") =>
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
      Layer.succeed(ScheduledCloudFire, {
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
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
