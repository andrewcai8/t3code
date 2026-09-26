// @effect-diagnostics globalDate:off - fixed wall-clock times drive the TestClock.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AutomationRunId,
  ProviderDriverKind,
  ProvisionRequestId,
  type AutomationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationStore, type StoredRun } from "./AutomationStore.ts";
import { makeAutomations, SCHEDULER_TICK, webhookPrompt } from "./Automations.ts";

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

/** The service with a runner that records each run it is handed instead of provisioning. */
const service = Effect.gen(function* () {
  const started: Array<StoredRun> = [];
  const automations = yield* makeAutomations((_automation, run) =>
    Effect.sync(() => started.push(run)),
  );
  return { automations, started };
});

const scoped = <A, E>(effect: Effect.Effect<A, E, AutomationStore>) =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        AutomationStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        NodeServices.layer,
      ),
    ),
  );

it.effect("runs the latest missed cron slot once on startup, then keeps the schedule", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:30:00.000Z");
      const { automations, started } = yield* service;
      yield* automations.create(input);

      yield* at("2026-09-26T11:30:00.000Z");
      const scheduler = yield* Effect.forkChild(automations.start);
      yield* TestClock.adjust(0);
      yield* TestClock.adjust(SCHEDULER_TICK);
      expect(started.map((run) => [run.trigger, run.scheduledFor])).toEqual([
        ["cron", "2026-09-26T11:00:00.000Z"],
      ]);

      yield* TestClock.adjust("30 minutes");
      expect(started.map((run) => run.scheduledFor)).toEqual([
        "2026-09-26T11:00:00.000Z",
        "2026-09-26T12:00:00.000Z",
      ]);
      yield* Fiber.interrupt(scheduler);
    }),
  ),
);

it.effect("resumes the runs a restart interrupted and leaves finished ones alone", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const store = yield* AutomationStore;
      const { automations, started } = yield* service;
      const { automation } = yield* automations.create({ ...input, schedule: null });
      const run = (id: string, state: StoredRun["state"]): StoredRun => ({
        id: AutomationRunId.make(id),
        automationId: automation.id,
        trigger: "manual",
        scheduledFor: null,
        requestId: ProvisionRequestId.make(`11111111-1111-4111-a111-00000000000${id.length}`),
        prompt: "Triage new issues.",
        state,
        environmentId: null,
        threadId: null,
        error: null,
        createdAt: "2026-09-26T07:00:00.000Z",
        updatedAt: "2026-09-26T07:00:00.000Z",
      });
      yield* store.insertRun(run("a", "attaching"));
      yield* store.insertRun(run("bb", "failed"));

      const scheduler = yield* Effect.forkChild(automations.start);
      yield* TestClock.adjust(0);
      expect(started.map(({ id, state }) => [id, state])).toEqual([["a", "attaching"]]);
      yield* Fiber.interrupt(scheduler);
    }),
  ),
);

it.effect("owes nothing for slots before the schedule was set or while disabled", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T09:59:00.000Z");
      const { automations, started } = yield* service;
      const { automation } = yield* automations.create({ ...input, enabled: false });
      yield* at("2026-09-26T10:00:30.000Z");
      yield* automations.tick;
      expect(started).toEqual([]);

      yield* at("2026-09-26T10:05:00.000Z");
      yield* automations.update(automation.id, input);
      yield* automations.tick;
      expect(started).toEqual([]);

      yield* at("2026-09-26T11:00:05.000Z");
      yield* automations.tick;
      yield* automations.tick;
      expect(started.map((run) => run.scheduledFor)).toEqual(["2026-09-26T11:00:00.000Z"]);
    }),
  ),
);

it.effect("starts a webhook run per delivery, answers redeliveries, and caps the hour", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations, started } = yield* service;
      const { webhookToken } = yield* automations.create({ ...input, schedule: null });
      const token = webhookToken!;

      expect(
        yield* automations.webhook("not-the-token", {
          body: "",
          contentType: undefined,
          deliveryId: undefined,
        }),
      ).toEqual({ kind: "not-found" });

      const delivery = {
        body: '{"ref":"refs/heads/main"}',
        contentType: "application/json",
        deliveryId: "delivery-1",
      };
      const first = yield* automations.webhook(token, delivery);
      const again = yield* automations.webhook(token, delivery);
      expect(
        first.kind === "started" && again.kind === "started" && first.run.id === again.run.id,
      ).toBe(true);
      expect(started.map((run) => run.prompt)).toEqual([
        'Triage new issues.\n\nThis run was started by a webhook. Its request body:\n\n```\n{\n  "ref": "refs/heads/main"\n}\n```',
      ]);

      for (let delivered = 2; delivered <= 20; delivered++)
        yield* automations.webhook(token, { ...delivery, deliveryId: `delivery-${delivered}` });
      expect(yield* automations.webhook(token, { ...delivery, deliveryId: "delivery-21" })).toEqual(
        { kind: "rate-limited" },
      );
      expect(started).toHaveLength(20);

      yield* TestClock.adjust("61 minutes");
      expect(
        (yield* automations.webhook(token, { ...delivery, deliveryId: "delivery-21" })).kind,
      ).toBe("started");
    }),
  ),
);

it.effect("keeps a webhook link across edits, and turning it off and on mints a new one", () =>
  scoped(
    Effect.gen(function* () {
      yield* at("2026-09-26T08:00:00.000Z");
      const { automations } = yield* service;
      const created = yield* automations.create({ ...input, schedule: null });
      const edited = yield* automations.update(created.automation.id, {
        ...input,
        schedule: null,
        prompt: "Triage and label new issues.",
      });
      expect(edited.webhookToken).toBe(null);
      const empty = { body: "", contentType: undefined, deliveryId: undefined };
      expect((yield* automations.webhook(created.webhookToken!, empty)).kind).toBe("started");

      yield* automations.update(created.automation.id, {
        ...input,
        schedule: null,
        webhook: false,
      });
      expect(yield* automations.webhook(created.webhookToken!, empty)).toEqual({
        kind: "not-found",
      });
      const reopened = yield* automations.update(created.automation.id, {
        ...input,
        schedule: null,
      });
      expect(reopened.webhookToken).not.toBe(created.webhookToken);
      expect((yield* automations.webhook(reopened.webhookToken!, empty)).kind).toBe("started");
    }),
  ),
);

it("fences a webhook body so its own backticks cannot close the block", () => {
  expect(webhookPrompt("Summarize.", { body: "see ```code```", contentType: "text/plain" })).toBe(
    "Summarize.\n\nThis run was started by a webhook. Its request body:\n\n````\nsee ```code```\n````",
  );
});
