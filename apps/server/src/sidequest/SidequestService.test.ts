import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SidequestService from "./SidequestService.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const impressionId = "7f9c1d5e-5d3a-4e0b-9a27-3a0f2b1c4d5e";
const adBody = {
  adText: "Ship faster",
  adCta: "Try it",
  adLink: "https://example.com/ship",
  impressionId,
  advertiser: { name: "Acme" },
};
const expiresAt = "2026-01-01T00:00:10.000Z";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface World {
  readonly requests: Array<RecordedRequest>;
  readonly routes: Map<string, () => { readonly status: number; readonly json?: unknown }>;
  runStatus: string;
  createdBy: string;
  creationSource: string;
  provider: string;
  question: string;
  answers: ReadonlyArray<string>;
}

const makeWorld = (): World => ({
  requests: [],
  routes: new Map([
    ["POST /api/device", () => ({ status: 201, json: { userCode: "ABCD-1234", expiresAt } })],
    ["GET /api/device", () => ({ status: 202 })],
    ["POST /api/ad", () => ({ status: 200, json: adBody })],
    [`POST /api/impression/${impressionId}`, () => ({ status: 200 })],
  ]),
  runStatus: "completed",
  createdBy: "user",
  creationSource: "web",
  provider: "claude",
  question: "How do I ship?",
  answers: ["First answer.", "Second answer."],
});

const at = (index: number) => DateTime.makeUnsafe(index * 1000);

const layerWorld = (world: World, settings: { readonly sidequestEnabled: boolean }) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const path = url.pathname;
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined;
        world.requests.push({
          method: request.method,
          path,
          authorization: request.headers.authorization,
          body,
        });
        const route = world.routes.get(`${request.method} ${path}`);
        const { status, json } = route?.() ?? { status: 404 };
        return HttpClientResponse.fromWeb(
          request,
          json === undefined ? new Response(null, { status }) : Response.json(json, { status }),
        );
      }),
    ),
  );
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: (_threadId, _fields, filter) =>
      Effect.succeed({
        runs: [
          {
            id: runId,
            status: world.runStatus,
            userMessageId: "message-user",
            providerInstanceId: world.provider,
          },
        ].filter((run) => filter?.runIds?.includes(run.id) ?? true),
        messages: [
          {
            id: "message-user",
            role: "user",
            runId,
            text: world.question,
            createdBy: world.createdBy,
            creationSource: world.creationSource,
            createdAt: at(0),
          },
          ...world.answers.map((text, index) => ({
            id: `message-assistant-${index}`,
            role: "assistant",
            runId,
            text,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: at(index + 1),
          })),
        ].filter(
          (message) =>
            (filter?.messageIds?.includes(message.id as never) ?? true) &&
            (filter?.messageRoles?.includes(message.role as never) ?? true) &&
            (filter?.messageRunIds?.includes(message.runId) ?? true),
        ),
      } as never),
  });
  return SidequestService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        http,
        threads,
        ServerSettings.layerTest(settings),
        ServerSecretStore.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sidequest-test-" })),
        ),
      ),
    ),
  );
};

interface RunOptions {
  readonly world?: World;
  readonly settings?: { readonly sidequestEnabled: boolean };
  /** File content of the Claude Code plugin's stored device, when the host has one. */
  readonly plugin?: string;
}

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  { world = makeWorld(), settings = { sidequestEnabled: true }, plugin }: RunOptions = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sidequest-home-" });
    if (plugin !== undefined) {
      const store = path.join(home, ".claude", "plugins", "store");
      yield* fileSystem.makeDirectory(store, { recursive: true });
      yield* fileSystem.writeFileString(path.join(store, "sidequest_sidequest-abc.json"), plugin);
    }
    return yield* effect.pipe(
      Effect.provide(layerWorld(world, settings)),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  }).pipe(Effect.scoped, Effect.provideService(HostProcess.Platform, "darwin"));

const storedDevice = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  secrets.get("sidequest-device").pipe(
    Effect.map((bytes) =>
      Option.match(bytes, {
        onNone: () => undefined,
        onSome: (value): unknown => JSON.parse(new TextDecoder().decode(value)),
      }),
    ),
  );

const adRequests = (world: World) => world.requests.filter((request) => request.path === "/api/ad");

const pluginDevice = JSON.stringify({ deviceKey: "sq_plugin" });
const connectedEmail = { status: 200, json: { email: "me@example.com" } };
const disconnectedMarker = { disconnected: true };

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("SidequestService", (it) => {
  describe("fetchAd gate", () => {
    it.effect.each([
      { name: "the setting is off", settings: { sidequestEnabled: false } },
      { name: "no device is connected", connected: false },
      { name: "the run has not completed", runStatus: "running" },
      { name: "an agent wrote the message", createdBy: "agent" },
      { name: "the message came from MCP", creationSource: "mcp" },
      { name: "the reply is empty", answers: ["  "] },
    ] as ReadonlyArray<{
      name: string;
      settings?: { sidequestEnabled: boolean };
      connected?: boolean;
      runStatus?: string;
      createdBy?: string;
      creationSource?: string;
      answers?: ReadonlyArray<string>;
    }>)("asks for no ad when $name", ({ settings, connected = true, ...overrides }) => {
      const world = Object.assign(makeWorld(), overrides);
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          if (connected) yield* sidequest.connect;
          expect(yield* sidequest.fetchAd({ threadId, runId })).toBeNull();
          expect(adRequests(world)).toEqual([]);
        }),
        { world, ...(settings === undefined ? {} : { settings }) },
      );
    });

    it.effect.each([
      { creationSource: "web", provider: "claude" },
      { creationSource: "mobile", provider: "codex" },
      { creationSource: "web", provider: "opencode" },
    ])(
      "sends a person-typed $creationSource turn on $provider with the device key",
      ({ creationSource, provider }) => {
        const world = Object.assign(makeWorld(), {
          creationSource,
          provider,
          question: "q".repeat(5000),
          answers: ["a".repeat(3000), "b".repeat(3000)],
        });
        return run(
          Effect.gen(function* () {
            const sidequest = yield* SidequestService.SidequestService;
            yield* sidequest.connect;
            expect(yield* sidequest.fetchAd({ threadId, runId })).toEqual(adBody);
            const [request] = adRequests(world);
            expect(request?.authorization).toMatch(/^Bearer sq_[\w-]{43}$/u);
            expect(request?.body).toEqual({
              placement: "inline",
              client: "t3code",
              question: "q".repeat(4000),
              answer: `${"a".repeat(3000)}\n\n${"b".repeat(3000)}`.slice(-4000),
              conversationId: threadId,
            });
          }),
          { world },
        );
      },
    );
  });

  it.effect.each([
    { name: "an ad", route: () => ({ status: 200, json: adBody }), expected: adBody },
    { name: "no ad", route: () => ({ status: 204 }), expected: null },
  ])("serves one request per run for $name", ({ route, expected }) => {
    const world = makeWorld();
    world.routes.set("POST /api/ad", route);
    return run(
      Effect.gen(function* () {
        const sidequest = yield* SidequestService.SidequestService;
        yield* sidequest.connect;
        expect(yield* sidequest.fetchAd({ threadId, runId })).toEqual(expected);
        expect(yield* sidequest.fetchAd({ threadId, runId })).toEqual(expected);
        expect(adRequests(world)).toHaveLength(1);
      }),
      { world },
    );
  });

  it.effect("drops an ad whose link is not https", () => {
    const world = makeWorld();
    world.routes.set("POST /api/ad", () => ({
      status: 200,
      json: { ...adBody, adLink: "http://example.com/ship" },
    }));
    return run(
      Effect.gen(function* () {
        const sidequest = yield* SidequestService.SidequestService;
        yield* sidequest.connect;
        expect(yield* sidequest.fetchAd({ threadId, runId })).toBeNull();
      }),
      { world },
    );
  });

  describe("connection", () => {
    it.effect("starts pending with a connect URL and keeps the key in the secret store", () =>
      run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          expect(yield* sidequest.getConnection).toEqual({ status: "disconnected" });
          expect(yield* sidequest.connect).toEqual({
            status: "pending",
            connectUrl: "https://getsidequest.dev/connect?code=ABCD-1234",
            userCode: "ABCD-1234",
            expiresAt,
          });
          expect(yield* storedDevice(secrets)).toEqual({
            deviceKey: expect.stringMatching(/^sq_[\w-]{43}$/u),
            pending: { userCode: "ABCD-1234", expiresAt },
          });
        }),
      ),
    );

    it.effect.each([
      { status: 202, json: undefined, expected: "pending", cleared: false },
      { status: 200, json: connectedEmail.json, expected: "connected", cleared: false },
      { status: 403, json: undefined, expected: "suspended", cleared: false },
      { status: 404, json: undefined, expected: "disconnected", cleared: true },
      { status: 500, json: undefined, expected: "unavailable", cleared: false },
    ])("reports $expected when the site answers $status", ({ status, json, expected, cleared }) => {
      const world = makeWorld();
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* sidequest.connect;
          world.routes.set("GET /api/device", () => ({ status, json }));
          expect((yield* sidequest.getConnection).status).toBe(expected);
          const stored = yield* storedDevice(secrets);
          expect(stored).toEqual(
            cleared
              ? disconnectedMarker
              : expect.objectContaining({ deviceKey: expect.any(String) }),
          );
        }),
        { world },
      );
    });

    it.effect("clears the pending code once the site reports the device connected", () => {
      const world = makeWorld();
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* sidequest.connect;
          world.routes.set("GET /api/device", () => connectedEmail);
          expect(yield* sidequest.getConnection).toEqual({
            status: "connected",
            email: "me@example.com",
          });
          expect(yield* storedDevice(secrets)).toMatchObject({ pending: null });
        }),
        { world },
      );
    });

    it.effect("drops a pending code that expired unapproved", () =>
      run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* sidequest.connect;
          yield* TestClock.setTime(Date.parse(expiresAt) + 1);
          expect(yield* sidequest.getConnection).toEqual({ status: "disconnected" });
          expect(yield* storedDevice(secrets)).toEqual(disconnectedMarker);
        }),
      ),
    );

    it.effect.each([
      { name: "region unavailable", status: 403 },
      { name: "rate limited", status: 429 },
    ])("stores nothing when connecting is $name", ({ status }) => {
      const world = makeWorld();
      world.routes.set("POST /api/device", () => ({ status }));
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          expect(yield* sidequest.connect).toEqual({ status: "unavailable" });
          expect(yield* storedDevice(secrets)).toBeUndefined();
        }),
        { world },
      );
    });

    it.effect("disconnect drops the device and stops ads", () => {
      const world = makeWorld();
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          yield* sidequest.connect;
          expect(yield* sidequest.disconnect).toEqual({ status: "disconnected" });
          expect(yield* storedDevice(secrets)).toEqual(disconnectedMarker);
          expect(yield* sidequest.fetchAd({ threadId, runId })).toBeNull();
          expect(adRequests(world)).toEqual([]);
        }),
        { world },
      );
    });
  });

  describe("Claude Code plugin device", () => {
    it.effect("adopts the plugin's key on first use and keeps its own copy", () => {
      const world = makeWorld();
      world.routes.set("GET /api/device", () => connectedEmail);
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          expect(yield* sidequest.getConnection).toEqual({
            status: "connected",
            email: "me@example.com",
          });
          expect(world.requests.map((request) => request.authorization)).toEqual([
            "Bearer sq_plugin",
          ]);
          expect(yield* storedDevice(secrets)).toEqual({ deviceKey: "sq_plugin", pending: null });
        }),
        { world, plugin: pluginDevice },
      );
    });

    it.effect("asks for ads with the adopted key before the site has confirmed it", () => {
      const world = makeWorld();
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          expect(yield* sidequest.fetchAd({ threadId, runId })).toEqual(adBody);
          expect(adRequests(world)[0]?.authorization).toBe("Bearer sq_plugin");
        }),
        { world, plugin: pluginDevice },
      );
    });

    it.effect.each([
      { name: "is not JSON", plugin: "not json" },
      { name: "has no device key", plugin: JSON.stringify({ deviceKey: "" }) },
      { name: "is missing" },
    ])("ignores a plugin file that $name", ({ plugin }) => {
      const world = makeWorld();
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          expect(yield* sidequest.getConnection).toEqual({ status: "disconnected" });
          expect(yield* sidequest.fetchAd({ threadId, runId })).toBeNull();
          expect(world.requests).toEqual([]);
        }),
        { world, ...(plugin === undefined ? {} : { plugin }) },
      );
    });

    it.effect("does not adopt the plugin's key again after a disconnect", () => {
      const world = makeWorld();
      world.routes.set("GET /api/device", () => connectedEmail);
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          expect((yield* sidequest.getConnection).status).toBe("connected");
          yield* sidequest.disconnect;
          expect(yield* sidequest.getConnection).toEqual({ status: "disconnected" });
          expect(yield* sidequest.fetchAd({ threadId, runId })).toBeNull();
          expect(world.requests.filter((request) => request.method === "GET")).toHaveLength(1);
          expect(adRequests(world)).toEqual([]);
        }),
        { world, plugin: pluginDevice },
      );
    });

    it.effect("lets a disconnected host connect a fresh device", () =>
      run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          yield* sidequest.disconnect;
          expect((yield* sidequest.connect).status).toBe("pending");
        }),
        { plugin: pluginDevice },
      ),
    );
  });

  describe("reportImpression", () => {
    const impressionRequests = (world: World) =>
      world.requests.filter((request) => request.path.startsWith("/api/impression/"));

    it.effect("reports a served impression once and never an unserved id", () => {
      const world = makeWorld();
      return run(
        Effect.gen(function* () {
          const sidequest = yield* SidequestService.SidequestService;
          yield* sidequest.connect;
          yield* sidequest.reportImpression({ impressionId });
          expect(impressionRequests(world)).toEqual([]);
          yield* sidequest.fetchAd({ threadId, runId });
          yield* sidequest.reportImpression({ impressionId: "forged" });
          yield* sidequest.reportImpression({ impressionId });
          yield* sidequest.reportImpression({ impressionId });
          expect(impressionRequests(world)).toEqual([
            {
              method: "POST",
              path: `/api/impression/${impressionId}`,
              authorization: expect.stringMatching(/^Bearer sq_/u),
              body: undefined,
            },
          ]);
        }),
        { world },
      );
    });

    it.effect(
      "retries a server error, stops on a client error, and lets a later call retry",
      () => {
        const world = makeWorld();
        return run(
          Effect.gen(function* () {
            const sidequest = yield* SidequestService.SidequestService;
            yield* sidequest.connect;
            yield* sidequest.fetchAd({ threadId, runId });
            world.routes.set(`POST /api/impression/${impressionId}`, () => ({ status: 500 }));
            const failing = yield* Effect.forkChild(sidequest.reportImpression({ impressionId }));
            yield* TestClock.adjust("1 minute");
            yield* Fiber.join(failing);
            expect(impressionRequests(world)).toHaveLength(4);

            world.routes.set(`POST /api/impression/${impressionId}`, () => ({ status: 404 }));
            yield* sidequest.reportImpression({ impressionId });
            yield* sidequest.reportImpression({ impressionId });
            expect(impressionRequests(world)).toHaveLength(5);
          }),
          { world },
        );
      },
    );
  });
});
