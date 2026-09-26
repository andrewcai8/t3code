// @effect-diagnostics preferSchemaOverJson:off - the fake child speaks raw JSON like a real one.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AutomationId,
  AutomationRunId,
  EnvironmentId,
  ProvisionRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Automation,
  type EnvironmentProvisionInput,
  type EnvironmentProvisionAttachResult,
  type EnvironmentProvisionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  makeAutomationRunner,
  runProvisionInput,
  type AutomationRunnerPorts,
} from "./AutomationRunner.ts";
import { AutomationStore, type StoredRun } from "./AutomationStore.ts";

const automation: Automation = {
  id: AutomationId.make("nightly"),
  name: "Nightly dependency bump",
  repository: "andrewcai8/t3code",
  branch: "main",
  prompt: "Bump dependencies and open a PR.",
  agentDriver: ProviderDriverKind.make("codex"),
  account: ProviderInstanceId.make("codex_work"),
  provider: "e2b",
  schedule: null,
  webhook: false,
  enabled: true,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
};

const requestId = ProvisionRequestId.make("11111111-1111-4111-a111-000000000001");
const run = (
  state: StoredRun["state"],
  environmentId: string | null = null,
  provisionAccepted = state !== "provisioning",
): StoredRun => ({
  id: AutomationRunId.make("run-1"),
  automationId: automation.id,
  trigger: "manual",
  scheduledFor: null,
  requestId,
  prompt: "Bump dependencies and open a PR.",
  provisionInput: runProvisionInput(automation, requestId, "2026-09-26T09:00:00.000Z"),
  provisionAccepted,
  state,
  environmentId: environmentId === null ? null : EnvironmentId.make(environmentId),
  threadId: null,
  error: null,
  disposedAt: null,
  createdAt: "2026-09-26T09:00:00.000Z",
  updatedAt: "2026-09-26T09:00:00.000Z",
});

interface ChildRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A child T3 server that has cloned one project and accepts every command. */
const fakeChild = (requests: Array<ChildRequest>) =>
  HttpClient.make((request, url) => {
    requests.push({
      method: request.method,
      url: url.toString(),
      authorization: request.headers.authorization,
      body: request.body._tag === "Uint8Array" ? JSON.parse(request.body.text ?? "null") : null,
    });
    const body =
      url.pathname === "/api/orchestration/shell"
        ? {
            snapshotSequence: 3,
            projects: [
              {
                id: "project-1",
                title: "t3code",
                workspaceRoot: "/home/user/t3code",
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-09-26T09:01:00.000Z",
                updatedAt: "2026-09-26T09:01:00.000Z",
              },
            ],
            threads: [],
            updatedAt: "2026-09-26T09:01:00.000Z",
          }
        : { sequence: requests.length };
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      ),
    );
  });

/** Fake manager ports that record the run's persisted state each time one is called. */
const fakeManager = (
  seen: Array<string>,
  provisioned: Array<EnvironmentProvisionInput>,
  overrides: {
    /** Answers to successive provision calls; the last one repeats. */
    readonly provision?: ReadonlyArray<EnvironmentProvisionResult>;
    readonly attach?: EnvironmentProvisionAttachResult;
  } = {},
) => {
  const stateNow = (label: string) =>
    AutomationStore.use((store) => store.listRuns(automation.id, 1)).pipe(
      Effect.map(([current]) => seen.push(`${label}:${current?.state}`)),
      Effect.orDie,
    );
  return Effect.gen(function* () {
    const context = yield* Effect.context<AutomationStore>();
    const withStore = <A, E>(effect: Effect.Effect<A, E, AutomationStore>) =>
      Effect.provide(effect, context);
    const ports: AutomationRunnerPorts = {
      environmentControl: {
        provision: (input) =>
          withStore(
            stateNow("provision").pipe(
              Effect.andThen(() => {
                provisioned.push(input);
                const answers = overrides.provision ?? [];
                return Effect.succeed(
                  answers[Math.min(provisioned.length, answers.length) - 1] ?? {
                    kind: "ready" as const,
                    requestId: input.requestId,
                    environment: {
                      environmentId: EnvironmentId.make("child-env"),
                      leaseId: input.requestId,
                      provider: "e2b" as const,
                      sandboxId: "sandbox-1",
                      projectDir: "/home/user/t3code",
                      providerInstanceId: "codex_work",
                      sourceRevision: null,
                      t3Revision: "rev",
                      artifactSha256: "sha",
                      control: {
                        preparationRoot: "/root",
                        brokerCredentialPath: "/root/broker-token",
                        localT3Url: "http://127.0.0.1:3773",
                        runtimeExecutable: "node",
                        runtimeEntrypoint: "/root/artifact/bin.js",
                      },
                    },
                  },
                );
              }),
            ),
          ),
        attach: (input) =>
          withStore(
            stateNow("attach").pipe(
              Effect.as(
                overrides.attach ?? {
                  kind: "attached" as const,
                  environmentId: EnvironmentId.make("child-env"),
                  pairingUrl: `https://child.test/pair#token=${input.requestId}`,
                },
              ),
            ),
          ),
        dispose: (input) =>
          withStore(
            stateNow(`dispose ${"requestId" in input ? input.requestId : "?"}`).pipe(
              Effect.as({ kind: "disposed" as const }),
            ),
          ),
        claim: (input) =>
          withStore(
            stateNow(`claim ${input.leaseId} ${input.environmentId} ${input.threadId}`).pipe(
              Effect.as({ kind: "claimed" as const }),
            ),
          ),
      },
      remoteAccess: (leaseId) =>
        withStore(
          stateNow(`remoteAccess ${leaseId}`).pipe(
            Effect.as({ origin: "https://child.test", brokerToken: "broker-token" }),
          ),
        ),
    };
    return ports;
  });
};

const withStore = <A, E>(effect: Effect.Effect<A, E, AutomationStore>) =>
  Effect.provide(effect, AutomationStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

it.layer(NodeServices.layer)("automation runner", (it) => {
  it.effect("provisions, attaches, then creates the chat and sends the prompt on the child", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("provisioning"));
        const seen: Array<string> = [];
        const provisioned: Array<EnvironmentProvisionInput> = [];
        const requests: Array<ChildRequest> = [];
        const runner = yield* makeAutomationRunner(yield* fakeManager(seen, provisioned));

        const finished = yield* runner(automation, run("provisioning")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild(requests)),
        );

        expect(provisioned).toEqual([
          {
            requestId: "11111111-1111-4111-a111-000000000001",
            provider: "e2b",
            agentDriver: "codex",
            providerInstanceId: "codex_work",
            pinAccount: true,
            repository: "andrewcai8/t3code",
            branch: "main",
            retentionDeadline: "2026-09-27T09:00:00.000Z",
          },
        ]);
        expect(seen).toEqual([
          "provision:provisioning",
          "attach:attaching",
          "remoteAccess 11111111-1111-4111-a111-000000000001:starting",
          "claim 11111111-1111-4111-a111-000000000001 child-env 7a70b895-a164-4c08-ad5b-76a54b016ed6:starting",
        ]);
        expect(requests).toEqual([
          {
            method: "GET",
            url: "https://child.test/api/orchestration/shell",
            authorization: "Bearer broker-token",
            body: null,
          },
          {
            method: "POST",
            url: "https://child.test/api/orchestration/dispatch",
            authorization: "Bearer broker-token",
            body: {
              type: "thread.create",
              commandId: "7c54a386-008d-4c0d-a01f-8c53dc91a47e",
              threadId: "7a70b895-a164-4c08-ad5b-76a54b016ed6",
              projectId: "project-1",
              title: "Nightly dependency bump",
              modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: "2026-09-26T09:00:00.000Z",
            },
          },
          {
            method: "POST",
            url: "https://child.test/api/orchestration/dispatch",
            authorization: "Bearer broker-token",
            body: {
              type: "thread.turn.start",
              commandId: "de4c54d9-6db9-4660-a180-874b1bc303c0",
              threadId: "7a70b895-a164-4c08-ad5b-76a54b016ed6",
              message: {
                messageId: "82f593b6-461d-4a36-a3f9-8f1282d80a32",
                role: "user",
                text: "Bump dependencies and open a PR.",
                attachments: [],
              },
              modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: "2026-09-26T09:00:00.000Z",
            },
          },
        ]);
        expect(finished).toMatchObject({
          state: "started",
          environmentId: "child-env",
          threadId: "7a70b895-a164-4c08-ad5b-76a54b016ed6",
          error: null,
        });
        expect(Option.getOrNull(yield* store.get(automation.id))?.automation.name).toBe(
          "Nightly dependency bump",
        );
      }),
    ),
  );

  it.effect("resumes a run a restart left in starting without provisioning again", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("starting", "child-env"));
        const seen: Array<string> = [];
        const provisioned: Array<EnvironmentProvisionInput> = [];
        const requests: Array<ChildRequest> = [];
        const runner = yield* makeAutomationRunner(yield* fakeManager(seen, provisioned));

        const finished = yield* runner(automation, run("starting", "child-env")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild(requests)),
        );

        expect(provisioned).toEqual([]);
        expect(
          requests.map(({ body }) => (body as { commandId?: string } | null)?.commandId),
        ).toEqual([
          undefined,
          "7c54a386-008d-4c0d-a01f-8c53dc91a47e",
          "de4c54d9-6db9-4660-a180-874b1bc303c0",
        ]);
        expect(finished?.state).toBe("started");
        expect(finished?.threadId).toBe("7a70b895-a164-4c08-ad5b-76a54b016ed6");
      }),
    ),
  );

  it.effect("fails the run with the manager's reason when provisioning is refused", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("provisioning"));
        const seen: Array<string> = [];
        const requests: Array<ChildRequest> = [];
        const runner = yield* makeAutomationRunner(
          yield* fakeManager(seen, [], {
            provision: [
              {
                kind: "refused",
                reason: "credentials",
                message: "The selected provider account is unavailable on this machine.",
              },
            ],
          }),
        );

        const finished = yield* runner(automation, run("provisioning")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild(requests)),
        );

        expect(seen).toEqual(["provision:provisioning"]);
        expect(requests).toEqual([]);
        expect(finished).toMatchObject({
          state: "failed",
          environmentId: null,
          threadId: null,
          error: "The selected provider account is unavailable on this machine.",
          disposedAt: null,
        });
      }),
    ),
  );

  it.effect("disposes the machine of a run that fails after its provision was accepted", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("provisioning"));
        const seen: Array<string> = [];
        const runner = yield* makeAutomationRunner(
          yield* fakeManager(seen, [], {
            attach: { kind: "refused", message: "This environment's lease has ended." },
          }),
        );

        const finished = yield* runner(automation, run("provisioning")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild([])),
        );

        expect(seen).toEqual([
          "provision:provisioning",
          "attach:attaching",
          "dispose 11111111-1111-4111-a111-000000000001:attaching",
        ]);
        expect(finished).toMatchObject({
          state: "failed",
          error: "This environment's lease has ended.",
          disposedAt: "1970-01-01T00:00:00.000Z",
        });
      }),
    ),
  );

  it.effect("gives up on a provision still pending after 30 minutes and disposes it", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("provisioning"));
        const seen: Array<string> = [];
        const runner = yield* makeAutomationRunner(
          yield* fakeManager(seen, [], {
            provision: [
              {
                kind: "pending",
                requestId,
                message: "The environment is still being prepared.",
              },
            ],
          }),
        );

        const fiber = yield* runner(automation, run("provisioning")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild([])),
          Effect.forkChild,
        );
        yield* TestClock.adjust("31 minutes");
        const finished = yield* Fiber.join(fiber);

        expect(seen.at(-1)).toBe("dispose 11111111-1111-4111-a111-000000000001:provisioning");
        expect(finished).toMatchObject({
          state: "failed",
          error:
            "The environment was not ready after 30 minutes. The environment is still being prepared.",
          disposedAt: "1970-01-01T00:30:00.000Z",
        });
      }),
    ),
  );

  it.effect("disposes the machine when a refusal comes after the request was accepted", () =>
    withStore(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-26T09:00:00.000Z"));
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("provisioning"));
        const seen: Array<string> = [];
        const runner = yield* makeAutomationRunner(
          yield* fakeManager(seen, [], {
            provision: [
              { kind: "pending", requestId, message: "Booting the Mac." },
              {
                kind: "refused",
                reason: "credentials",
                message: "codex_work is over its usage limit.",
              },
            ],
          }),
        );

        const fiber = yield* runner(automation, run("provisioning")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild([])),
          Effect.forkChild,
        );
        yield* TestClock.adjust("10 seconds");
        const finished = yield* Fiber.join(fiber);

        expect(seen).toEqual([
          "provision:provisioning",
          "provision:provisioning",
          "dispose 11111111-1111-4111-a111-000000000001:provisioning",
        ]);
        expect(finished).toMatchObject({
          state: "failed",
          error: "codex_work is over its usage limit.",
          provisionAccepted: true,
          disposedAt: "2026-09-26T09:00:10.000Z",
        });
      }),
    ),
  );

  it.effect("resumes from the request frozen at trigger time, not the edited automation", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* AutomationStore;
        const edited = {
          ...automation,
          branch: "dev",
          account: null,
          agentDriver: ProviderDriverKind.make("cursor"),
        };
        yield* store.save({
          automation: edited,
          webhookSecretHash: null,
          scheduleSince: edited.createdAt,
        });
        yield* store.insertRun(run("provisioning"));
        const provisioned: Array<EnvironmentProvisionInput> = [];
        const requests: Array<ChildRequest> = [];
        const runner = yield* makeAutomationRunner(yield* fakeManager([], provisioned));

        const finished = yield* runner(edited, run("provisioning")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild(requests)),
        );

        expect(provisioned).toEqual([
          {
            requestId: "11111111-1111-4111-a111-000000000001",
            provider: "e2b",
            agentDriver: "codex",
            providerInstanceId: "codex_work",
            pinAccount: true,
            repository: "andrewcai8/t3code",
            branch: "main",
            retentionDeadline: "2026-09-27T09:00:00.000Z",
          },
        ]);
        expect(
          (requests[1]?.body as { modelSelection?: unknown } | undefined)?.modelSelection,
        ).toEqual({
          instanceId: "codex",
          model: "gpt-6-astra",
        });
        expect(finished?.state).toBe("started");
      }),
    ),
  );

  it.effect("fails a run whose attach hangs past its step limit and disposes the machine", () =>
    withStore(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-09-26T09:00:00.000Z"));
        const store = yield* AutomationStore;
        yield* store.save({
          automation,
          webhookSecretHash: null,
          scheduleSince: automation.createdAt,
        });
        yield* store.insertRun(run("attaching"));
        const seen: Array<string> = [];
        const manager = yield* fakeManager(seen, []);
        const runner = yield* makeAutomationRunner({
          ...manager,
          environmentControl: { ...manager.environmentControl, attach: () => Effect.never },
        });

        const fiber = yield* runner(automation, run("attaching")).pipe(
          Effect.provideService(HttpClient.HttpClient, fakeChild([])),
          Effect.forkChild,
        );
        yield* TestClock.adjust("5 minutes");
        const finished = yield* Fiber.join(fiber);

        expect(seen).toEqual(["dispose 11111111-1111-4111-a111-000000000001:attaching"]);
        expect(finished).toMatchObject({
          state: "failed",
          error: "Connecting to the environment did not finish in 5m.",
          disposedAt: "2026-09-26T09:05:00.000Z",
        });
      }),
    ),
  );
});
