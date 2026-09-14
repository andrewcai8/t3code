import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest";

import { ServerConfig } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { orchestrationHttpApiLayer } from "./http.ts";
import { OrchestrationLayerLive } from "./runtimeLayer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const authenticated = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
    sessionId: AuthSessionId.make("http-launch-test"),
    subject: "test",
    method: "bearer-access-token",
    scopes: new Set([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
  }),
);

const makeLayer = (directory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const requestServices = Layer.mergeAll(
        WorkspacePaths.layer,
        ServerConfig.layerTest(directory, path.join(directory, "home")),
      ).pipe(Layer.provideMerge(NodeServices.layer));
      return orchestrationHttpApiLayer.pipe(
        HttpRouter.provideRequest(requestServices),
        Layer.provideMerge(authenticated),
        Layer.provideMerge(OrchestrationLayerLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provide(makeSqlitePersistenceLive(path.join(directory, "state.sqlite"))),
        Layer.provide(requestServices),
        Layer.provideMerge(NodeHttpPlatform.layer),
        Layer.provideMerge(Etag.layer),
        Layer.provideMerge(NodeServices.layer),
      );
    }),
  );

type HttpTestCommand = Extract<
  ClientOrchestrationCommand,
  {
    type:
      | "project.create"
      | "thread.create"
      | "thread.turn.start"
      | "thread.handoff.begin"
      | "thread.handoff.cancel";
  }
>;

const dispatch = (payload: HttpTestCommand) =>
  HttpApiTest.groups(EnvironmentHttpApi, ["orchestration"]).pipe(
    Effect.flatMap((client) => {
      switch (payload.type) {
        case "project.create":
          return client.orchestration.dispatch({ payload, headers: {} });
        case "thread.create":
          return client.orchestration.dispatch({ payload, headers: {} });
        case "thread.turn.start":
          return client.orchestration.dispatch({ payload, headers: {} });
        case "thread.handoff.begin":
          return client.orchestration.dispatch({ payload, headers: {} });
        case "thread.handoff.cancel":
          return client.orchestration.dispatch({ payload, headers: {} });
      }
    }),
    Effect.scoped,
  );

const launchCommands = (workspaceRoot: string) => {
  const projectId = ProjectId.make("automation-project");
  const threadId = ThreadId.make("automation-thread");
  const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
  const createdAt = "2026-09-12T00:00:00.000Z";
  return [
    {
      type: "project.create",
      commandId: CommandId.make("automation-project-create"),
      projectId,
      title: "Automation project",
      workspaceRoot,
      createdAt,
    },
    {
      type: "thread.create",
      commandId: CommandId.make("automation-thread-create"),
      threadId,
      projectId,
      title: "Repair report",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "repair/report-1",
      worktreePath: workspaceRoot,
      createdAt,
    },
    {
      type: "thread.turn.start",
      commandId: CommandId.make("automation-turn-start"),
      threadId,
      modelSelection,
      message: {
        messageId: MessageId.make("automation-message"),
        role: "user",
        text: "Repair the reported bug and verify the result.",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    },
  ] satisfies ClientOrchestrationCommand[];
};

describe("orchestration HTTP automation launch", () => {
  it.effect(
    "retains its handoff fence across a lost reply, restart, cancellation and old retry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-http-handoff-" });
        const threadId = ThreadId.make("automation-thread");
        const begin = {
          type: "thread.handoff.begin",
          commandId: CommandId.make("http-handoff"),
          threadId,
        } satisfies ClientOrchestrationCommand;
        const receipt = yield* Effect.gen(function* () {
          yield* Effect.forEach(launchCommands(directory), dispatch);
          return yield* dispatch(begin);
        }).pipe(Effect.provide(makeLayer(directory)), Effect.scoped);
        yield* Effect.gen(function* () {
          const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["orchestration"]);
          expect(yield* dispatch(begin)).toEqual(receipt);
          const read = yield* client.orchestration.threadSnapshot({
            params: { threadId },
            payload: {},
            headers: {},
          });
          expect(read.thread.handoff).toEqual({
            status: "fenced",
            handoffId: begin.commandId,
            admissionSequence: receipt.sequence,
          });
          const turn = launchCommands(directory).find(
            (command) => command.type === "thread.turn.start",
          );
          if (turn === undefined) throw new Error("Missing test turn");
          const error = yield* dispatch({
            ...turn,
            commandId: CommandId.make("blocked-http-turn"),
          }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "EnvironmentInternalError",
            reason: "orchestration_dispatch_failed",
          });
          yield* dispatch({
            type: "thread.handoff.cancel",
            commandId: CommandId.make("http-cancel"),
            threadId,
            handoffId: begin.commandId,
          });
        }).pipe(Effect.provide(makeLayer(directory)), Effect.scoped);
        yield* Effect.gen(function* () {
          expect(yield* dispatch(begin)).toEqual(receipt);
          const client = yield* HttpApiTest.groups(EnvironmentHttpApi, ["orchestration"]);
          const read = yield* client.orchestration.threadSnapshot({
            params: { threadId },
            payload: {},
            headers: {},
          });
          expect(read.thread.handoff).toBeNull();
          expect(read.thread.messages.filter((message) => message.role === "user")).toHaveLength(1);
          const engine = yield* OrchestrationEngineService;
          const events = yield* Stream.runCollect(engine.readEvents(0));
          expect(events.map((event) => event.type)).toEqual([
            "project.created",
            "thread.created",
            "thread.message-sent",
            "thread.turn-start-requested",
            "thread.handoff-begun",
            "thread.handoff-canceled",
          ]);
        }).pipe(Effect.provide(makeLayer(directory)), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect.each([1, 2, 3])("retries after losing response %i and restarting the server", (count) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-http-launch-" });
      const commands = launchCommands(directory);
      const receipts = yield* Effect.forEach(commands.slice(0, count), (command) =>
        Effect.gen(function* () {
          const [receipt, duplicate] = yield* Effect.all([dispatch(command), dispatch(command)], {
            concurrency: 2,
          });
          expect(duplicate).toEqual(receipt);
          return receipt;
        }),
      ).pipe(Effect.provide(makeLayer(directory)), Effect.scoped);

      const events = yield* Effect.gen(function* () {
        const retried = yield* Effect.forEach(commands, dispatch);
        expect(retried.slice(0, count)).toEqual(receipts);
        const engine = yield* OrchestrationEngineService;
        return yield* Stream.runCollect(engine.readEvents(0));
      }).pipe(Effect.provide(makeLayer(directory)), Effect.scoped);
      expect(events.map((event) => event.type)).toEqual([
        "project.created",
        "thread.created",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(events.find((event) => event.type === "thread.created")?.payload).toMatchObject({
        threadId: "automation-thread",
        branch: "repair/report-1",
        worktreePath: directory,
      });
      expect(events.find((event) => event.type === "thread.message-sent")?.payload).toMatchObject({
        messageId: "automation-message",
        text: "Repair the reported bug and verify the result.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects bootstrap before accepting a turn without preparing its worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-http-bootstrap-" });
      const commands = launchCommands(directory);
      yield* Effect.gen(function* () {
        for (const command of commands) {
          if (command.type !== "thread.turn.start") {
            yield* dispatch(command);
            continue;
          }
          const error = yield* dispatch({
            ...command,
            bootstrap: {
              prepareWorktree: { projectCwd: directory, baseBranch: "main" },
            },
          }).pipe(Effect.flip);
          expect(error).toMatchObject({
            _tag: "EnvironmentRequestInvalidError",
            reason: "invalid_command",
          });
          const engine = yield* OrchestrationEngineService;
          const events = yield* Stream.runCollect(engine.readEvents(0));
          expect(events.map((event) => event.type)).toEqual(["project.created", "thread.created"]);
          yield* dispatch(command);
        }
      }).pipe(Effect.provide(makeLayer(directory)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
