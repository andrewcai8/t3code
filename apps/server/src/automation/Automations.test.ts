// @effect-diagnostics globalDate:off - fixed wall-clock times drive the TestClock.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
  EnvironmentId,
  ProviderDriverKind,
  ProvisionRequestId,
  ThreadId,
  type Automation,
  type AutomationInput,
} from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationStore, type StoredRun } from "./AutomationStore.ts";
import {
  makeAutomations,
  makeDisposeMachine,
  SCHEDULER_TICK,
  webhookPrompt,
  type WebhookDelivery,
} from "./Automations.ts";

const input: AutomationInput = {
  name: "Hourly triage",
  repository: "andrewcai8/t3code",
  branch: null,
  prompt: "Triage new issues.",
  agentDriver: ProviderDriverKind.make("claudeAgent"),
  account: null,
  provider: "namespace",
  schedule: { cron: "0 * * * *", timeZone: "UTC" },
  webhook: true,
  enabled: true,
};

const at = (iso: string) => TestClock.setTime(Date.parse(iso));
const settle = TestClock.adjust(0);

/**
 * The service with a runner that records each run it is handed and, unless `finish` is false,
 * moves it straight to started, standing in for the provisioning a real run does.
 */
const service = (
  options: {
    readonly finish?: boolean;
    /** Answers to successive dispose calls; the last one repeats. */
    readonly disposals?: ReadonlyArray<boolean>;
  } = {},
) =>
  Effect.gen(function* () {
    const store = yield* AutomationStore;
    const launched: Array<StoredRun> = [];
    const disposed: Array<string> = [];
    const answers = options.disposals ?? [true];
    const complete = (run: StoredRun) =>
      Effect.gen(function* () {
        const now = run.createdAt;
        yield* store.advanceRun(run.id, "provisioning", { state: "attaching" }, now);
        yield* store.advanceRun(
          run.id,
          "attaching",
          { state: "starting", environmentId: EnvironmentId.make("child") },
          now,
        );
        yield* store.advanceRun(
          run.id,
          "starting",
          { state: "started", threadId: ThreadId.make("thread") },
          now,
        );
      });
    const automations = yield* makeAutomations({
      // A run that does not finish stands in for one whose first provision call is in flight.
      run: (_automation, run) =>
        Effect.sync(() => launched.push(run)).pipe(
          Effect.andThen(options.finish === false ? Effect.never : complete(run)),
        ),
      dispose: (run) =>
        Effect.sync(() => {
          disposed.push(run.requestId);
          return answers[Math.min(disposed.length, answers.length) - 1]!;
        }),
      listProvisioned: Effect.succeed([]),
    });
    const webhook = (token: string, delivery: WebhookDelivery) =>
      Effect.gen(function* () {
        const target = yield* automations.webhookTarget(token);
        if (target.kind !== "found") return { kind: target.kind };
        const outcome = yield* automations.deliverWebhook(target.automation, delivery);
        return outcome.kind === "accepted"
          ? { kind: outcome.kind, runId: outcome.run.id, state: outcome.run.state }
          : { kind: outcome.kind };
      });
    return { automations, store, launched, disposed, webhook };
  });

const scoped = <A, E>(
  effect: Effect.Effect<A, E, AutomationStore | Crypto.Crypto | Scope.Scope | SqlClient.SqlClient>,
) =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        AutomationStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        NodeServices.layer,
      ),
    ),
  );

const delivery = (deliveryId: string | undefined, body = ""): WebhookDelivery => ({
  body,
  contentType: body === "" ? undefined : "application/json",
  deliveryId,
});

it.effect("runs the latest missed cron slot once on startup, then keeps the schedule", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:30:00.000Z");
      const { automations, launched } = yield* service();
      yield* automations.create(input);

      yield* at("2026-09-26T11:30:00.000Z");
      const scheduler = yield* Effect.forkChild(automations.start);
      yield* settle;
      yield* TestClock.adjust(SCHEDULER_TICK);
      expect(launched.map((run) => [run.trigger, run.scheduledFor])).toEqual([
        ["cron", "2026-09-26T11:00:00.000Z"],
      ]);

      yield* TestClock.adjust("30 minutes");
      expect(launched.map((run) => run.scheduledFor)).toEqual([
        "2026-09-26T11:00:00.000Z",
        "2026-09-26T12:00:00.000Z",
      ]);
      yield* Fiber.interrupt(scheduler);
    }),
  ),
);

it.effect("keeps a daily 2:30 schedule firing across the spring-forward change", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-03-06T12:00:00.000Z");
      const { automations, launched } = yield* service();
      yield* automations.create({
        ...input,
        schedule: { cron: "30 2 * * *", timeZone: "America/New_York" },
      });
      for (const now of [
        "2026-03-07T08:00:00.000Z",
        "2026-03-08T12:00:00.000Z",
        "2026-03-09T03:00:00.000Z",
        "2026-03-09T12:00:00.000Z",
      ]) {
        yield* at(now);
        yield* automations.tick;
        yield* settle;
      }
      expect(launched.map((run) => run.scheduledFor)).toEqual([
        "2026-03-07T07:30:00.000Z",
        "2026-03-08T07:30:00.000Z",
        "2026-03-09T06:30:00.000Z",
      ]);
    }),
  ),
);

it.effect("resumes the runs a restart interrupted and leaves finished ones alone", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, store, launched } = yield* service();
      const { automation } = yield* automations.create({ ...input, schedule: null });
      const run = (id: string, suffix: string, state: StoredRun["state"]): StoredRun => ({
        id: AutomationRunId.make(id),
        automationId: automation.id,
        trigger: "manual",
        scheduledFor: null,
        requestId: ProvisionRequestId.make(`11111111-1111-4111-a111-00000000000${suffix}`),
        prompt: "Triage new issues.",
        provisionInput: {
          requestId: ProvisionRequestId.make(`11111111-1111-4111-a111-00000000000${suffix}`),
          provider: "namespace",
          providerInstanceId: "claudeAgent",
        },
        state,
        environmentId: null,
        threadId: null,
        error: null,
        disposedAt: null,
        createdAt: "2026-09-26T07:00:00.000Z",
        updatedAt: "2026-09-26T07:00:00.000Z",
      });
      yield* store.insertRun(run("finished", "1", "failed"));
      yield* store.insertRun(run("interrupted", "2", "attaching"));

      const scheduler = yield* Effect.forkChild(automations.start);
      yield* settle;
      expect(launched.map(({ id, state }) => [id, state])).toEqual([["interrupted", "attaching"]]);
      yield* Fiber.interrupt(scheduler);
    }),
  ),
);

it.effect("owes nothing for slots before the schedule started counting or while disabled", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T09:59:00.000Z");
      const { automations, launched } = yield* service();
      const { automation } = yield* automations.create({ ...input, enabled: false });
      yield* at("2026-09-26T10:00:30.000Z");
      yield* automations.tick;
      expect(launched).toEqual([]);

      yield* at("2026-09-26T10:05:00.000Z");
      yield* automations.update(automation.id, input);
      yield* automations.tick;
      expect(launched).toEqual([]);

      yield* at("2026-09-26T11:00:05.000Z");
      yield* automations.tick;
      yield* settle;
      yield* automations.tick;
      yield* settle;
      expect(launched.map((run) => run.scheduledFor)).toEqual(["2026-09-26T11:00:00.000Z"]);
    }),
  ),
);

it.effect("moves the schedule's floor only when the schedule changes, not on other edits", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T09:30:00.000Z");
      const { automations, launched } = yield* service();
      const { automation } = yield* automations.create(input);

      // 10:00 is owed. Rotating the link and renaming at 10:10 must not forgive it.
      yield* at("2026-09-26T10:10:00.000Z");
      yield* automations.rotateWebhook(automation.id);
      yield* automations.update(automation.id, { ...input, name: "Renamed" });
      yield* automations.tick;
      yield* settle;
      expect(launched.map((run) => run.scheduledFor)).toEqual(["2026-09-26T10:00:00.000Z"]);

      // A new expression starts counting from the edit: 10:15 is not owed, 10:30 is.
      yield* at("2026-09-26T10:20:00.000Z");
      yield* automations.update(automation.id, {
        ...input,
        schedule: { cron: "15,45 * * * *", timeZone: "UTC" },
      });
      yield* at("2026-09-26T10:40:00.000Z");
      yield* automations.tick;
      yield* settle;
      expect(launched.map((run) => run.scheduledFor)).toEqual(["2026-09-26T10:00:00.000Z"]);
      yield* at("2026-09-26T10:50:00.000Z");
      yield* automations.tick;
      yield* settle;
      expect(launched.map((run) => run.scheduledFor)).toEqual([
        "2026-09-26T10:00:00.000Z",
        "2026-09-26T10:45:00.000Z",
      ]);
    }),
  ),
);

it.effect("skips a trigger while a run is in flight, but a redelivery still gets its run", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, launched, webhook } = yield* service({ finish: false });
      const { automation, webhookToken } = yield* automations.create({ ...input, schedule: null });

      const first = yield* webhook(webhookToken!, delivery("delivery-1"));
      const manual = yield* automations.runNow(automation.id);
      const redelivered = yield* webhook(webhookToken!, delivery("delivery-1"));
      yield* settle;

      expect([first.kind, "state" in first ? first.state : null]).toEqual([
        "accepted",
        "provisioning",
      ]);
      expect([manual.state, manual.error]).toEqual([
        "skipped",
        "Skipped because the previous run was still starting.",
      ]);
      expect(redelivered).toEqual(first);
      expect(launched.map((run) => run.trigger)).toEqual(["webhook"]);
    }),
  ),
);

it.effect("caps webhook runs at 20 an hour even for a concurrent burst", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, webhook } = yield* service();
      const { webhookToken } = yield* automations.create({ ...input, schedule: null });

      const outcomes = yield* Effect.all(
        Array.from({ length: 25 }, (_, index) =>
          webhook(webhookToken!, delivery(`burst-${index}`)),
        ),
        { concurrency: "unbounded" },
      );
      const kinds = outcomes.map((outcome) => outcome.kind);
      expect([
        kinds.filter((kind) => kind === "accepted").length,
        kinds.filter((kind) => kind === "rate-limited").length,
      ]).toEqual([20, 5]);

      // A redelivery of an accepted delivery is answered with its run, not refused by the cap.
      const acceptedIndex = kinds.indexOf("accepted");
      expect((yield* webhook(webhookToken!, delivery(`burst-${acceptedIndex}`))).kind).toBe(
        "accepted",
      );

      yield* TestClock.adjust("61 minutes");
      expect((yield* webhook(webhookToken!, delivery("next-hour"))).kind).toBe("accepted");
    }),
  ),
);

it.effect("rejects unknown and disabled links and puts the body in the prompt", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, launched, webhook } = yield* service();
      const { automation, webhookToken } = yield* automations.create({ ...input, schedule: null });

      expect(yield* webhook("not-the-token", delivery(undefined))).toEqual({ kind: "not-found" });
      yield* webhook(webhookToken!, delivery("d-1", '{"ref":"refs/heads/main"}'));
      yield* settle;
      expect(launched.map((run) => run.prompt)).toEqual([
        'Triage new issues.\n\nThis run was started by a webhook. Its request body:\n\n```\n{\n  "ref": "refs/heads/main"\n}\n```',
      ]);

      yield* automations.update(automation.id, { ...input, schedule: null, enabled: false });
      expect(yield* webhook(webhookToken!, delivery("d-2"))).toEqual({ kind: "disabled" });
    }),
  ),
);

it.effect("keeps a webhook link across edits, and turning it off and on mints a new one", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, webhook } = yield* service();
      const created = yield* automations.create({ ...input, schedule: null });
      const edited = yield* automations.update(created.automation.id, {
        ...input,
        schedule: null,
        prompt: "Triage and label new issues.",
      });
      expect(edited.webhookToken).toBe(null);
      expect((yield* webhook(created.webhookToken!, delivery("a"))).kind).toBe("accepted");

      yield* automations.update(created.automation.id, {
        ...input,
        schedule: null,
        webhook: false,
      });
      expect(yield* webhook(created.webhookToken!, delivery("b"))).toEqual({ kind: "not-found" });
      const reopened = yield* automations.update(created.automation.id, {
        ...input,
        schedule: null,
      });
      expect(reopened.webhookToken).not.toBe(created.webhookToken);
      expect((yield* webhook(reopened.webhookToken!, delivery("c"))).kind).toBe("accepted");
    }),
  ),
);

it.effect(
  "deleting an automation during its run's first provision call stops it and disposes",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* at("2026-09-26T08:00:00.000Z");
        const { automations, store, launched, disposed } = yield* service({ finish: false });
        const { automation } = yield* automations.create({ ...input, schedule: null });
        const run = yield* automations.runNow(automation.id);
        yield* settle;
        expect(launched.map(({ id }) => id)).toEqual([run.id]);

        yield* automations.remove(automation.id);
        expect(disposed).toEqual([run.requestId]);
        expect(yield* store.listRuns(automation.id as Automation["id"], 10)).toEqual([]);
      }),
    ),
);

it.effect("a trigger that raced a delete starts nothing and reports the automation gone", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, launched } = yield* service();
      const { automation } = yield* automations.create({ ...input, schedule: null });
      // The webhook resolved its automation, then the automation was deleted before it ran.
      yield* automations.remove(automation.id);

      expect(yield* automations.deliverWebhook(automation, delivery("late"))).toEqual({
        kind: "not-found",
      });
      expect((yield* Effect.flip(automations.runNow(automation.id))).message).toBe(
        "This automation no longer exists.",
      );
      expect(launched).toEqual([]);
    }),
  ),
);

it.effect(
  "keeps retrying a deleted run's disposal until the manager confirms, then forgets it",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* at("2026-09-26T08:00:00.000Z");
        const { automations, store, disposed } = yield* service({
          finish: false,
          disposals: [false, true],
        });
        const { automation } = yield* automations.create({ ...input, schedule: null });
        const run = yield* automations.runNow(automation.id);
        yield* settle;

        yield* automations.remove(automation.id);
        const pending = (yield* store.pendingDisposals).map((entry) => [entry.id, entry.error]);
        expect(pending).toEqual([[run.id, "The automation was deleted."]]);

        yield* automations.sweep;
        expect(disposed).toEqual([run.requestId, run.requestId]);
        expect(yield* store.pendingDisposals).toEqual([]);
        expect(yield* store.listRuns(automation.id as Automation["id"], 10)).toEqual([]);
      }),
    ),
);

it.effect("fails a run left in flight with no fiber and disposes its machine", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, store, disposed } = yield* service();
      const { automation } = yield* automations.create({ ...input, schedule: null });
      const requestId = ProvisionRequestId.make("11111111-1111-4111-a111-000000000009");
      yield* store.insertRun({
        id: AutomationRunId.make("orphan"),
        automationId: automation.id,
        trigger: "manual",
        scheduledFor: null,
        requestId,
        prompt: "Triage new issues.",
        provisionInput: { requestId, provider: "namespace", providerInstanceId: "claudeAgent" },
        state: "provisioning",
        environmentId: null,
        threadId: null,
        error: null,
        disposedAt: null,
        createdAt: "2026-09-26T08:00:00.000Z",
        updatedAt: "2026-09-26T08:00:00.000Z",
      });

      yield* at("2026-09-26T08:01:00.000Z");
      yield* automations.sweep;
      expect((yield* store.listRuns(automation.id, 1))[0]?.state).toBe("provisioning");

      yield* at("2026-09-26T08:03:00.000Z");
      yield* automations.sweep;
      expect(disposed).toEqual([requestId]);
      expect(
        (yield* store.listRuns(automation.id, 1)).map(({ state, error, disposedAt }) => ({
          state,
          error,
          disposedAt,
        })),
      ).toEqual([
        {
          state: "failed",
          error: "The run stopped unexpectedly.",
          disposedAt: "2026-09-26T08:03:00.000Z",
        },
      ]);
    }),
  ),
);

it("fences a webhook body so its own backticks cannot close the block", () => {
  expect(webhookPrompt("Summarize.", { body: "see ```code```", contentType: "text/plain" })).toBe(
    "Summarize.\n\nThis run was started by a webhook. Its request body:\n\n````\nsee ```code```\n````",
  );
});

it.effect("disposal calls the manager only for a request it recorded", () =>
  scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const calls: Array<string> = [];
      const dispose = yield* makeDisposeMachine({
        dispose: (input) =>
          Effect.sync(() => {
            calls.push("requestId" in input ? input.requestId : input.sandboxId);
            return { kind: "refused" as const, reason: "unknown" as const, message: "pending" };
          }),
      });
      const run = (suffix: string): StoredRun => {
        const requestId = ProvisionRequestId.make(`11111111-1111-4111-a111-00000000000${suffix}`);
        return {
          id: AutomationRunId.make(`run-${suffix}`),
          automationId: AutomationId.make("nightly"),
          trigger: "manual",
          scheduledFor: null,
          requestId,
          prompt: "Run.",
          provisionInput: { requestId, provider: "e2b", providerInstanceId: "codex" },
          state: "failed",
          environmentId: null,
          threadId: null,
          error: "refused",
          disposedAt: null,
          createdAt: "2026-09-26T08:00:00.000Z",
          updatedAt: "2026-09-26T08:00:00.000Z",
        };
      };
      yield* sql`
        INSERT INTO provision_operations (request_id, request_hash, request_json, state_json,
          revision, created_at, updated_at)
        VALUES ('11111111-1111-4111-a111-000000000002', 'h', '{}', '{"kind":"create_issued"}', 1,
          '2026-09-26T08:00:00.000Z', '2026-09-26T08:00:00.000Z')
      `;

      expect([yield* dispose(run("1")), yield* dispose(run("2"))]).toEqual([true, false]);
      expect(calls).toEqual(["11111111-1111-4111-a111-000000000002"]);
    }),
  ),
);

it.effect("a run a trigger launched is not launched again by startup's resume", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, store, launched, disposed } = yield* service({ finish: false });
      const { automation } = yield* automations.create({ ...input, schedule: null });
      // A request served at activation launches its run before startup lists unfinished runs.
      const run = yield* automations.runNow(automation.id);
      const scheduler = yield* Effect.forkChild(automations.start);
      yield* settle;
      expect(launched.map(({ id }) => id)).toEqual([run.id]);

      // The single fiber still owns the run, so the orphan sweep leaves it alone.
      yield* at("2026-09-26T08:05:00.000Z");
      yield* automations.sweep;
      expect([(yield* store.listRuns(automation.id, 1))[0]?.state, disposed]).toEqual([
        "provisioning",
        [],
      ]);
      yield* Fiber.interrupt(scheduler);
    }),
  ),
);
