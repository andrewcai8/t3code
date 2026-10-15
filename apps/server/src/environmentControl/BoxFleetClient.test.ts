// @effect-diagnostics nodeBuiltinImport:off - a raw HTTP and WebSocket server stands in for a box.
import { expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as NodeHttp from "node:http";

import * as BoxFleetClient from "./BoxFleetClient.ts";

/** A box that accepts the host's connection and then answers nothing, as a busy box does. */
const silentBox = Effect.gen(function* () {
  const registered = yield* Deferred.make<void>();
  const pings = yield* Queue.unbounded<void>();
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      NodeHttp.createServer((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ticket: "ticket" }));
      }),
    ),
    (server) => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  const sockets = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocketServer({ server, path: "/ws" })),
    (sockets) =>
      Effect.sync(() => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
      }),
  );
  sockets.on("connection", (socket) =>
    socket.on("message", (data) => {
      for (const message of [JSON.parse(String(data))].flat()) {
        if (message._tag === "Ping") Queue.offerUnsafe(pings, undefined);
        if (message.tag === "fleet.connect") Deferred.doneUnsafe(registered, Exit.void);
      }
    }),
  );
  yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(0, resolve)));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing box port");
  return { origin: `http://127.0.0.1:${address.port}`, registered, pings };
});

it.effect("keeps a box connection through 15 seconds without an answer", () =>
  Effect.gen(function* () {
    const box = yield* silentBox;
    const client = yield* BoxFleetClient.BoxFleetClient;
    const connection = yield* client.open({ origin: box.origin, brokerToken: "token" });
    const served = yield* connection
      .connect({ clientId: "t3-cloud-host", environments: [] })
      .pipe(Stream.runDrain, Effect.forkScoped);
    yield* Deferred.await(box.registered);

    yield* TestClock.adjust("10 seconds");
    const quietStretch = yield* Effect.raceFirst(
      Queue.take(box.pings).pipe(Effect.andThen(Queue.take(box.pings)), Effect.as("open")),
      Fiber.await(served).pipe(Effect.as("dropped")),
    );
    expect(quietStretch).toBe("open");

    yield* TestClock.adjust("10 seconds");
    const exit = yield* Fiber.await(served);
    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toMatchObject({
      value: { _tag: "BoxUnreachableError" },
    });
  }).pipe(Effect.provide(BoxFleetClient.layer.pipe(Layer.provideMerge(FetchHttpClient.layer)))),
);
