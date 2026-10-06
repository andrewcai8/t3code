import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentControlHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NetAddress from "effect/net/NetAddress";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { failEnvironmentAuthInvalid } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import {
  OrchestratorCommandIdConflictError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAccountSwitch from "../provider/ProviderAccountSwitch.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { EnvironmentControl } from "./EnvironmentControl.ts";
import { environmentControlBodyLimitLayer, environmentControlHttpApiLayer } from "./http.ts";

class ProvisionHttpApi extends HttpApi.make("environment").add(EnvironmentControlHttpApi) {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const token = request.headers.authorization;
    if (token !== "Bearer operator" && token !== "Bearer reader") {
      return yield* failEnvironmentAuthInvalid("missing_credential");
    }
    return yield* Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("provision-http-proof"),
      subject: "proof",
      method: "bearer-access-token",
      scopes: new Set([
        token === "Bearer operator" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
      ]),
    });
  }),
);

it.effect(
  "the provision HTTP routes enforce scopes, preserve retry IDs and delegate the shared service",
  () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; input: unknown }> = [];
      const environmentId = EnvironmentId.make("prepared-environment");
      const service = Layer.succeed(
        EnvironmentControl,
        EnvironmentControl.of({
          namespaceProxyOrigin: () => Effect.succeed(null),
          list: Effect.succeed([]),
          provisionProviders: Effect.succeed([]),
          controlConfig: Effect.succeed(null),
          provisionedSkills: Effect.succeed(undefined),
          listProvisioned: () => Effect.succeed([]),
          start: () => Effect.die("Unused in provision HTTP proof"),
          stop: () => Effect.die("Unused in provision HTTP proof"),
          pause: () => Effect.die("Unused in provision HTTP proof"),
          resume: () => Effect.die("Unused in provision HTTP proof"),
          upgrade: () => Effect.die("Unused in provision HTTP proof"),
          switchAccount: () => Effect.die("Unused in provision HTTP proof"),
          keep: () => Effect.die("Unused in provision HTTP proof"),
          restore: () => Effect.die("Unused in provision HTTP proof"),
          presence: () => Effect.die("Unused in provision HTTP proof"),
          provision: (input) =>
            Effect.sync(() => {
              calls.push({ method: "provision", input });
              return { kind: "pending", requestId: input.requestId, message: "Preparing" };
            }),
          attach: (input) =>
            Effect.sync(() => {
              calls.push({ method: "attach", input });
              return {
                kind: "attached",
                environmentId,
                pairingUrl: "https://example.invalid/fresh-pairing-grant",
              };
            }),
          claim: (input) =>
            Effect.sync(() => {
              calls.push({ method: "claim", input });
              return { kind: "claimed" };
            }),
          touch: (input) =>
            Effect.sync(() => {
              calls.push({ method: "touch", input });
              return { kind: "touched" };
            }),
          dispose: (input) =>
            Effect.sync(() => {
              calls.push({ method: "dispose", input });
              return { kind: "disposed" };
            }),
        }),
      );
      const routes = HttpApiBuilder.layer(ProvisionHttpApi).pipe(
        Layer.provide(environmentControlHttpApiLayer),
        Layer.provide(service),
        // The launchThread route needs these to build; this proof never calls it.
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            Layer.mock(ProviderAccountSwitch.ProviderAccountSwitch)({}),
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-provision-http-" }),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Layer.provide(auth),
        Layer.provide(environmentControlBodyLimitLayer),
      );
      const http = HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      );
      yield* Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address as NetAddress.InetAddress;
        const origin = `http://127.0.0.1:${address.port}`;
        const requestId = "b601c79f-8b46-44e9-9675-1ed8d1d6c286";
        const input = {
          requestId,
          provider: "e2b",
          providerInstanceId: "codex-account",
          workspaceFiles: [
            {
              destination: ".evidence/report.json",
              sha256: "a".repeat(64),
              contentsBase64: "e30=",
            },
          ],
        };
        const client = yield* HttpClient.HttpClient;
        const post = Effect.fnUntraced(function* (
          method: string,
          body: unknown,
          credential = "operator",
        ) {
          const request = HttpClientRequest.post(`/api/environment-control/${method}`).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${credential}`),
            HttpClientRequest.bodyText(yield* encodeJson(body), "application/json"),
          );
          const response = yield* client.execute(request);
          const text = yield* response.text;
          return {
            status: response.status,
            body: text ? yield* decodeJson(text) : null,
          };
        });
        expect((yield* post("list-provisioned", {}, "missing")).status).toBe(401);
        expect(yield* post("list-provisioned", {}, "reader")).toEqual({ status: 200, body: [] });
        expect((yield* post("provision", input, "missing")).status).toBe(401);
        expect((yield* post("provision", input, "reader")).status).toBe(403);
        expect(
          (yield* post("provision", { provider: "e2b", providerInstanceId: "codex-account" }))
            .status,
        ).toBe(400);
        expect(calls).toEqual([]);
        const expectedPending = {
          status: 200,
          body: { kind: "pending", requestId, message: "Preparing" },
        };
        expect(yield* post("provision", input)).toEqual(expectedPending);
        expect(yield* post("provision", input)).toEqual(expectedPending);
        expect(calls).toEqual([
          { method: "provision", input },
          { method: "provision", input },
        ]);
        expect((yield* post("attach", { requestId })).body).toEqual({
          kind: "attached",
          environmentId,
          pairingUrl: "https://example.invalid/fresh-pairing-grant",
        });
        const claim = { leaseId: "lease", environmentId, threadId: "thread" };
        expect((yield* post("claim", claim)).body).toEqual({ kind: "claimed" });
        expect((yield* post("touch", { leaseId: "lease" })).body).toEqual({ kind: "touched" });
        expect((yield* post("dispose", { requestId })).body).toEqual({ kind: "disposed" });
        expect(calls.slice(2)).toEqual([
          { method: "attach", input: { requestId } },
          { method: "claim", input: claim },
          { method: "touch", input: { leaseId: "lease" } },
          { method: "dispose", input: { requestId } },
        ]);
        const oversized = yield* HttpClient.execute(
          HttpClientRequest.post(`${origin}/api/environment-control/provision`, {
            headers: {
              authorization: "Bearer operator",
              "content-type": "application/json",
              "content-length": String(90 * 1024 * 1024 + 1),
            },
          }),
        ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
        expect(oversized.status).toBe(413);
        yield* oversized.text;
        expect(calls).toHaveLength(6);
      }).pipe(Effect.provide(http), Effect.scoped);
    }),
);

it.effect("the launch-thread route checks scope and tells a refused launch from a failed one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
    const threadId = ThreadId.make("thread-launched");
    const projectId = ProjectId.make("project-1");
    const launchFailure = (input: ThreadLaunchService.ThreadLaunchInput, cause: unknown) =>
      new ThreadLaunchService.ThreadLaunchError({
        operation: "create-thread",
        commandId: input.commandId,
        projectId: input.projectId,
        threadId,
        cause,
      });
    const launches = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input);
        if (input.commandId === "refused") {
          return Effect.fail(
            launchFailure(
              input,
              new OrchestratorCommandIdConflictError({
                commandId: input.commandId,
                commandType: "thread.create",
                receiptThreadId: ThreadId.make("thread-other"),
                commandThreadId: threadId,
              }),
            ),
          );
        }
        if (input.commandId === "broken") {
          return Effect.fail(launchFailure(input, new OrchestratorProjectionError({ threadId })));
        }
        return Effect.succeed({
          threadId,
          projection: {},
          resumed: true,
        } as unknown as ThreadLaunchService.ThreadLaunchResult);
      },
    });
    const routes = HttpApiBuilder.layer(ProvisionHttpApi).pipe(
      Layer.provide(environmentControlHttpApiLayer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(EnvironmentControl)({}),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
            enqueueCommand: (effect) => effect,
          }),
          launches,
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(ProviderAccountSwitch.ProviderAccountSwitch)({}),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-launch-thread-http-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Layer.provide(auth),
    );
    const http = HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
    );
    yield* Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const launch = Effect.fnUntraced(function* (commandId: string, credential = "operator") {
        const body = {
          commandId,
          projectId,
          title: "Cloud chat",
          modelSelection: { instanceId: "codex", model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: "Fix the build", attachments: [] },
        };
        const request = HttpClientRequest.post("/api/orchestration/launch-thread").pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${credential}`),
          HttpClientRequest.setHeader(
            ORCHESTRATION_PROTOCOL_HEADER,
            ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          ),
          HttpClientRequest.bodyText(yield* encodeJson(body), "application/json"),
        );
        const response = yield* client.execute(request);
        const text = yield* response.text;
        return { status: response.status, body: text ? yield* decodeJson(text) : null };
      });
      expect((yield* launch("accepted", "reader")).status).toBe(403);
      expect(launched).toEqual([]);
      expect((yield* launch("refused")).status).toBe(400);
      expect((yield* launch("broken")).status).toBe(500);
      expect(yield* launch("accepted")).toEqual({
        status: 200,
        body: { threadId: "thread-launched", resumed: true },
      });
      expect(launched.at(-1)).toEqual({
        commandId: CommandId.make("accepted"),
        projectId,
        title: "Cloud chat",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: "Fix the build", attachments: [] },
        createdBy: "user",
        creationSource: "server",
      });
    }).pipe(Effect.provide(http), Effect.scoped);
  }),
);
