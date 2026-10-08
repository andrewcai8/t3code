import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CLOUD_FORKS_ENVIRONMENT_ID,
  EnvironmentId,
  type FleetInvokeInput,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetBroker from "../home/FleetBroker.ts";
import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Project from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { routeHome, runAsHome } from "./homeRouting.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as HomeHandlers from "./toolkits/home/handlers.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { HomeToolkit } from "./toolkits/home/tools.ts";

const box = EnvironmentId.make("box-a");
const sibling = EnvironmentId.make("box-b");
const chat = ThreadId.make("chat-a");
const target = ThreadId.make("chat-b");
const codex = ProviderInstanceId.make("codex");

const launched = {
  threadId: ThreadId.make("chat-c"),
  link: "[Profile the build](t3-thread://v1/box-c/chat-c)",
  projectId: ProjectId.make("project-app"),
  modelSelection: { instanceId: codex, model: "gpt-5.5" },
  runId: null,
  status: null,
};

const topLevelChat = {
  id: chat,
  projectId: ProjectId.make("project-app"),
  deletedAt: null,
  archivedAt: null,
  activeRunId: "run",
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  lineage: {
    parentThreadId: null as ThreadId | null,
    relationshipToParent: null as "fork" | "subagent" | null,
    rootThreadId: chat,
  },
};

/** A cloud box's server: no Home, and a fleet host connected unless `hostConnected` is false. */
const onBox = (
  caller: Partial<typeof topLevelChat> = {},
  options: { readonly hostConnected?: boolean; readonly desktop?: boolean } = {},
) => {
  const relayed: Array<[EnvironmentId, FleetInvokeInput]> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: box,
      requestNamespace: "session",
      thread: { threadId: chat, providerSessionId: "session", providerInstanceId: codex },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({ ...topLevelChat, ...caller } as unknown as OrchestrationV2ThreadShell),
    }),
    Layer.mock(HomeService.HomeService)({
      available: options.desktop === true,
      isHome: () => Effect.succeed(false),
    }),
    Layer.mock(FleetService.FleetService)({}),
    Layer.mock(FleetBroker.FleetBroker)({
      reach: Effect.succeed({ hostConnected: options.hostConnected !== false, environments: [] }),
      invoke: (environmentId, input) => {
        relayed.push([environmentId, input]);
        return Effect.succeed(launched);
      },
    }),
  );
  return { layer, relayed };
};

const actor = { environmentId: box, threadId: chat };

it.effect("relays a top-level cloud chat's calls to another chat through its host", () => {
  const { layer, relayed } = onBox();
  return Effect.gen(function* () {
    yield* routeHome(sibling, "threads.send", { threadId: target, message: "Rebase on main." });
    const local = yield* routeHome(box, "threads.read", { threadId: target });
    expect(Option.isNone(local)).toBe(true);
    expect(relayed).toEqual([
      [
        sibling,
        {
          actor,
          request: { op: "threads.send", input: { threadId: target, message: "Rebase on main." } },
        },
      ],
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("keeps a subagent on its own box", () => {
  const { layer, relayed } = onBox({
    lineage: { parentThreadId: chat, relationshipToParent: "subagent", rootThreadId: chat },
  });
  return Effect.gen(function* () {
    const error = yield* routeHome(sibling, "threads.read", { threadId: target }).pipe(Effect.flip);
    expect(error.code).toBe("capability_denied");
    expect(relayed).toEqual([]);
  }).pipe(Effect.provide(layer));
});

it.effect("lets a cloud chat outside full-access read other chats but not change them", () => {
  const { layer, relayed } = onBox({ runtimeMode: "approval-required" });
  return Effect.gen(function* () {
    yield* routeHome(sibling, "threads.read", { threadId: target });
    const error = yield* routeHome(sibling, "threads.interrupt", { threadId: target }).pipe(
      Effect.flip,
    );
    expect(error.code).toBe("capability_denied");
    expect(relayed.map(([, input]) => input.request.op)).toEqual(["threads.read"]);
  }).pipe(Effect.provide(layer));
});

it.effect("gives no reach without a host, or to a thread the desktop relays for", () =>
  Effect.gen(function* () {
    for (const options of [{ hostConnected: false }, { desktop: true }]) {
      const { layer, relayed } = onBox({}, options);
      const error = yield* routeHome(sibling, "threads.read", { threadId: target }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      expect(error.code).toBe("capability_denied");
      expect(relayed).toEqual([]);
    }
  }),
);

it.effect("hands a cloud chat's launch elsewhere to its host, which picks the thread id", () => {
  const { layer, relayed } = onBox();
  const dependencies = Layer.mergeAll(
    layer,
    NodeCrypto.layer,
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Project.ProjectService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-cloud-reach-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  return Effect.gen(function* () {
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        environmentId: sibling,
        title: "Profile the build",
        message: "Find the slowest step.",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toEqual(launched);
    expect(relayed).toEqual([
      [
        sibling,
        {
          actor,
          request: {
            op: "threads.launch",
            input: {
              title: "Profile the build",
              runtimeMode: "full-access",
              interactionMode: "default",
              message: "Find the slowest step.",
            },
          },
        },
      ],
    ]);
  });
});

it.effect("sends forks to the host only for a top-level chat in full-access mode", () =>
  Effect.gen(function* () {
    const input = { jobs: [{ command: "pnpm test" }] };
    const allowed = onBox();
    yield* runAsHome(CLOUD_FORKS_ENVIRONMENT_ID, "forks.run", input).pipe(
      Effect.provide(allowed.layer),
    );
    expect(allowed.relayed).toEqual([
      [CLOUD_FORKS_ENVIRONMENT_ID, { actor, request: { op: "forks.run", input } }],
    ]);
    for (const caller of [
      { runtimeMode: "approval-required" },
      { lineage: { parentThreadId: chat, relationshipToParent: "subagent", rootThreadId: chat } },
    ] as Array<Partial<typeof topLevelChat>>) {
      const refused = onBox(caller);
      const error = yield* runAsHome(CLOUD_FORKS_ENVIRONMENT_ID, "forks.run", input).pipe(
        Effect.flip,
        Effect.provide(refused.layer),
      );
      expect(error.code).toBe("capability_denied");
      expect(refused.relayed).toEqual([]);
    }
  }),
);

it.effect("waits out the pause a fork batch causes and asks the host again", () => {
  const { layer } = onBox();
  const batch = { batchId: "batch-1", state: "finished" as const, jobs: [] };
  const registration = {
    clientId: "t3-cloud-host",
    environments: [{ environmentId: CLOUD_FORKS_ENVIRONMENT_ID, label: "Forks", connected: true }],
  };
  // The box's own services, with the real broker in place of the fake one.
  const dependencies = Layer.mergeAll(
    layer,
    Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    FleetBroker.layer.pipe(Layer.provide(NodeCrypto.layer)),
  );
  return Effect.gen(function* () {
    const broker = yield* FleetBroker.FleetBroker;
    const toolkit = yield* HomeToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(HomeHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const first = yield* broker.connect(registration);
    const host = yield* Stream.take(first, 1).pipe(Stream.runCollect, Effect.forkChild);
    const call = yield* toolkit
      .handle("t3_fork_status", { batchId: "batch-1" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
    // The host received the call, then the box paused and the connection dropped.
    yield* Fiber.join(host);
    yield* Fiber.interrupt(host);
    const second = yield* broker.connect(registration);
    const answered = yield* second.pipe(
      Stream.take(1),
      Stream.runForEach((request) =>
        broker.respond({ requestId: request.requestId, result: batch }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(answered);
    const result = yield* Fiber.join(call);
    expect(result.at(-1)?.result).toEqual(batch);
  }).pipe(Effect.provide(dependencies));
});
