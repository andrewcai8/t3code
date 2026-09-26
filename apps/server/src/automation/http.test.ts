import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AutomationStore, type StoredRun } from "./AutomationStore.ts";
import { Automations, makeAutomations } from "./Automations.ts";
import { automationWebhookRouteLayer } from "./http.ts";

it.effect(
  "the webhook link starts a run, hides unknown tokens, and refuses what it cannot take",
  () =>
    Effect.gen(function* () {
      const launched: Array<StoredRun> = [];
      const automations = yield* makeAutomations({
        run: (_automation, run) =>
          Effect.sync(() => launched.push(run)).pipe(Effect.andThen(Effect.never)),
        dispose: () => Effect.void,
        listProvisioned: Effect.succeed([]),
      });
      const input = {
        name: "Deploy smoke",
        repository: "andrewcai8/t3code",
        branch: null,
        prompt: "Smoke test the deploy.",
        agentDriver: ProviderDriverKind.make("codex"),
        account: null,
        provider: "e2b" as const,
        schedule: null,
        webhook: true,
        enabled: true,
      };
      const { automation, webhookToken } = yield* automations.create(input);
      const http = HttpRouter.serve(automationWebhookRouteLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(Layer.succeed(Automations, automations)),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );
      yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const post = Effect.fnUntraced(function* (token: string, body: string) {
          const response = yield* client.execute(
            HttpClientRequest.post(`/api/automations/hooks/${token}`).pipe(
              HttpClientRequest.bodyText(body, "text/plain"),
            ),
          );
          return { status: response.status, body: yield* response.json };
        });

        expect(yield* post("wrong-token", "hello")).toEqual({
          status: 404,
          body: { error: "not_found" },
        });
        expect((yield* post(webhookToken!, "x".repeat(64 * 1024 + 1))).status).toBe(413);
        const chunked = yield* client.execute(
          HttpClientRequest.post(`/api/automations/hooks/${webhookToken}`).pipe(
            HttpClientRequest.bodyStream(
              Stream.make(new Uint8Array(40 * 1024), new Uint8Array(40 * 1024)),
            ),
          ),
        );
        // A streamed body carries no length, so only reading it can find it too long.
        expect(chunked.status).toBe(413);

        const accepted = yield* post(webhookToken!, "deploy 42 finished");
        expect(accepted.status).toBe(202);
        expect(launched.map((run) => [run.trigger, run.prompt])).toEqual([
          [
            "webhook",
            "Smoke test the deploy.\n\nThis run was started by a webhook. Its request body:\n\n```\ndeploy 42 finished\n```",
          ],
        ]);
        expect(accepted.body).toEqual({ runId: launched[0]!.id, state: "provisioning" });
        expect((yield* post(webhookToken!, "deploy 43")).body).toMatchObject({ state: "skipped" });

        for (let sent = 3; sent <= 20; sent++) yield* post(webhookToken!, `deploy ${sent}`);
        expect(yield* post(webhookToken!, "deploy 21")).toEqual({
          status: 429,
          body: { error: "rate_limited" },
        });

        yield* automations.update(automation.id, { ...input, enabled: false });
        expect(yield* post(webhookToken!, "deploy 22")).toEqual({
          status: 409,
          body: { error: "automation_disabled" },
        });
        expect(launched).toHaveLength(1);
      }).pipe(Effect.provide(http));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          AutomationStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          NodeServices.layer,
        ),
      ),
    ),
);
