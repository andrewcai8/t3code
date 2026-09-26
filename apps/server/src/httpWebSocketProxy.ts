import * as Effect from "effect/Effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

/**
 * Upgrade the client's request and relay frames unchanged between it and the
 * upstream WebSocket at `upstreamUrl`. Whichever side closes first ends the
 * other via scope teardown: a close fails that side's pull, which loses the race.
 */
export const proxyWebSocket = Effect.fn("HttpWebSocketProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
  }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const pumpFrames = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });
