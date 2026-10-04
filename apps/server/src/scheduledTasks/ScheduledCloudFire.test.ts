import { assert, it } from "@effect/vitest";
import {
  ProvisionRequestId,
  ScheduledTask,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { EnvironmentControl } from "../environmentControl/EnvironmentControl.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledCloudFire from "./ScheduledCloudFire.ts";

const task = Schema.decodeUnknownSync(ScheduledTask)({
  id: "scheduled-task:nightly",
  title: "Nightly triage",
  prompt: "Triage new issues.",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: "project-1",
  threadId: null,
  target: "e2b",
  workspaceStrategy: { type: "worktree", baseRef: "origin/release", startFromOrigin: true },
  modelSelection: { instanceId: "claude-work", model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
});
const firedAt = DateTime.makeUnsafe("2026-10-03T09:00:00.000Z");
const isRequestId = Schema.is(ProvisionRequestId);

it("maps a fire to a routed provision request whose chat starts the task's prompt", () => {
  const input = ScheduledCloudFire.cloudFireInput({
    task,
    provider: "e2b",
    fireKey: "fire-1",
    firedAt,
    repository: "acme/widgets",
  });
  const { requestId, chat, ...rest } = input;
  assert.deepEqual(rest, {
    retentionDeadline: "2026-10-04T09:00:00.000Z",
    provider: "e2b",
    providerInstanceId: "claude-work",
    repository: "acme/widgets",
    branch: "release",
  });
  assert.isTrue(isRequestId(requestId));
  const { messageId: _messageId, ...firstTurn } = chat?.firstTurn ?? {};
  assert.deepEqual(firstTurn, {
    text: "Triage new issues.",
    title: "Nightly triage",
    modelSelection: { instanceId: "claude-work", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-03T09:00:00.000Z",
  });
});

it("names the same request, chat, and message for every retry of one fire", () => {
  const fire = (fireKey: string) =>
    ScheduledCloudFire.cloudFireInput({
      task,
      provider: "e2b",
      fireKey,
      firedAt,
      repository: "a/b",
    });
  const first = fire("fire-1");
  const retry = fire("fire-1");
  const next = fire("fire-2");
  assert.equal(retry.requestId, first.requestId);
  assert.equal(retry.chat?.threadId, first.chat?.threadId);
  assert.equal(retry.chat?.firstTurn?.messageId, first.chat?.firstTurn?.messageId);
  assert.notEqual(next.requestId, first.requestId);
  assert.notEqual(next.chat?.threadId, first.chat?.threadId);
  assert.notEqual(first.chat?.threadId, first.requestId);
});

it("clones the default branch of a repository-less or branchless project as asked", () => {
  const root = { ...task, workspaceStrategy: { type: "root" as const } };
  const input = (repository: string | undefined) =>
    ScheduledCloudFire.cloudFireInput({
      task: root,
      provider: "namespace",
      fireKey: "fire-1",
      firedAt,
      repository,
    });
  assert.equal(input("acme/widgets").repository, "acme/widgets");
  assert.isFalse("branch" in input("acme/widgets"));
  assert.isFalse("repository" in input(undefined));
});

const fireWith = (results: ReadonlyArray<EnvironmentProvisionResult>) =>
  Effect.gen(function* () {
    const provisioned = yield* Ref.make<ReadonlyArray<EnvironmentProvisionInput>>([]);
    const disposed = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = ScheduledCloudFire.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(EnvironmentControl)({
            provision: (input) =>
              Ref.modify(provisioned, (calls) => [
                results[Math.min(calls.length, results.length - 1)]!,
                [...calls, input],
              ]),
            dispose: (input) =>
              Ref.update(disposed, (calls) => [...calls, input]).pipe(
                Effect.as({ kind: "disposed" as const }),
              ),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  repositoryIdentity: { owner: "acme", name: "widgets" },
                } as never),
              ),
          }),
        ),
      ),
    );
    const fiber = yield* Effect.gen(function* () {
      const { fire } = yield* ScheduledCloudFire.ScheduledCloudFire;
      return yield* fire({ task, provider: "e2b", fireKey: "fire-1" });
    }).pipe(Effect.provide(layer), Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    return {
      exit: yield* Fiber.join(fiber),
      provisioned: yield* Ref.get(provisioned),
      disposed: yield* Ref.get(disposed),
    };
  });

const ready: EnvironmentProvisionResult = {
  kind: "ready",
  requestId: ProvisionRequestId.make("00000000-0000-4000-a000-000000000000"),
  environment: {
    environmentId: "box" as never,
    leaseId: "lease",
    provider: "e2b",
    sandboxId: "sandbox",
    projectDir: "/workspace",
    providerInstanceId: "claude-work",
    sourceRevision: null,
    t3Revision: "rev",
    artifactSha256: "sha",
    firstTurn: "started",
    control: {
      preparationRoot: "/p",
      brokerCredentialPath: "/p/b",
      localT3Url: "http://127.0.0.1:1",
      runtimeExecutable: "node",
      runtimeEntrypoint: "/p/a",
    },
  },
};

it.effect("retries a pending machine under the same request until it is ready", () =>
  Effect.gen(function* () {
    const { exit, provisioned, disposed } = yield* fireWith([
      { kind: "pending", requestId: ready.requestId, message: "Still preparing." },
      ready,
    ]);
    assert.equal(exit._tag, "Success");
    assert.equal(provisioned.length, 2);
    assert.equal(provisioned[1]?.requestId, provisioned[0]?.requestId);
    assert.equal(provisioned[0]?.repository, "acme/widgets");
    assert.deepEqual(disposed, []);
  }),
);

it.effect("fails a refused fire with the host's reason and disposes its request", () =>
  Effect.gen(function* () {
    const { exit, provisioned, disposed } = yield* fireWith([
      { kind: "refused", reason: "credentials", message: "No usable Claude account." },
    ]);
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.include(String(exit.cause), "No usable Claude account.");
    }
    assert.deepEqual(disposed, [{ requestId: provisioned[0]?.requestId }]);
  }),
);
