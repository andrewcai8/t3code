import { afterEach, describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as Socket from "effect/unstable/socket/Socket";
import { EnvironmentControl } from "./EnvironmentControl.ts";
import {
  provisionedEnvironmentGatewayRouteLayer,
  forwardedHeaders,
  resolveProvisionedEnvironmentTarget,
} from "./ProvisionedEnvironmentGateway.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (origin: string | null) => {
  const requests: Array<{
    url: string;
    authorization: string | undefined;
    cookie: string | undefined;
    dpop: string | undefined;
    host: string | undefined;
    headers: Record<string, string | undefined>;
  }> = [];
  const client = HttpClient.make((request, _url, _signal) =>
    Effect.sync(() => {
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        cookie: request.headers.cookie,
        dpop: request.headers.dpop,
        host: request.headers.host,
        headers: {
          "x-guest": request.headers["x-guest"],
          "content-type": request.headers["content-type"],
        },
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response("guest response", { status: 200, headers: { "content-type": "text/plain" } }),
      );
    }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    provisionedEnvironmentGatewayRouteLayer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentControl, {
          namespaceProxyOrigin: () => Effect.succeed(origin),
        } as unknown as EnvironmentControl["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests };
};

describe("provisioned environment gateway", () => {
  it("forwards the lease suffix, query, body, and guest bearer auth", async () => {
    const { handler, requests } = fixture("http://namespace-proxy.test");
    const response = await handler(
      new Request("http://manager.test/api/provisioned-environment/lease%20opaque/api/run?q=1", {
        method: "POST",
        headers: {
          authorization: "Bearer guest",
          "content-type": "application/json",
          cookie: "manager=session",
          dpop: "manager-proof",
          host: "attacker.test",
          connection: "keep-alive",
          "x-guest": "preserved",
        },
        body: "request body",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("guest response");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://namespace-proxy.test/api/run?q=1");
    expect(requests[0]?.headers).toMatchObject({
      "x-guest": "preserved",
    });
    expect(requests[0]?.headers).toMatchObject({
      "content-type": "application/json",
    });
    expect(requests[0]?.headers).not.toHaveProperty("cookie");
    expect(requests[0]?.headers).not.toHaveProperty("dpop");
    expect(requests[0]?.headers).not.toHaveProperty("host");
  });

  it("preserves guest bearer auth while stripping manager credentials", () => {
    expect(
      forwardedHeaders({
        headers: {
          authorization: "Bearer guest",
          cookie: "manager=session",
          dpop: "manager-proof",
          host: "attacker.test",
          "x-guest": "preserved",
        },
      } as unknown as Parameters<typeof forwardedHeaders>[0]),
    ).toEqual({ authorization: "Bearer guest", "x-guest": "preserved" });
  });

  it("fails closed without forwarding unknown or inactive leases", async () => {
    const { handler, requests } = fixture(null);
    const response = await handler(
      new Request("http://manager.test/api/provisioned-environment/missing/api/run"),
    );
    expect(response.status).toBe(404);
    expect(requests).toEqual([]);
  });

  it("forwards the websocket suffix and ticket without manager headers", () => {
    const resolved = resolveProvisionedEnvironmentTarget(
      new URL(
        "http://manager.test/api/provisioned-environment/lease%20opaque/ws?wsTicket=guest-ticket",
      ),
      "http://namespace-proxy.test",
    );
    expect(resolved).toEqual({
      leaseId: "lease opaque",
      target: new URL("http://namespace-proxy.test/ws?wsTicket=guest-ticket"),
    });
  });

  effectIt.effect("relays websocket frames both ways between the client and the guest", () =>
    Effect.gen(function* () {
      const upstreamUrls: Array<string> = [];
      const echoRoute = HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          upstreamUrls.push(request.url);
          const socket = yield* request.upgrade;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const writer = yield* socket.writer;
              const { pull } = yield* socket.reader;
              while (true) {
                for (const chunk of yield* pull) {
                  yield* writer.write(
                    `echo:${typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)}`,
                  );
                }
              }
            }),
          ).pipe(Effect.catchCause(() => Effect.void));
          return HttpServerResponse.empty();
        }),
      );
      const serveOnLoopback = <A, E, R, D>(
        routes: Layer.Layer<A, E, R>,
        dependencies: Layer.Layer<D>,
      ) =>
        HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provide(dependencies),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );
      const portOf = (services: Context.Context<HttpServer.HttpServer>) =>
        (Context.get(services, HttpServer.HttpServer).address as NetAddress.InetAddress).port;

      const echoed = yield* Effect.gen(function* () {
        const guest = yield* Layer.build(serveOnLoopback(echoRoute, Layer.empty));
        const gateway = yield* Layer.build(
          serveOnLoopback(
            provisionedEnvironmentGatewayRouteLayer,
            Layer.succeed(EnvironmentControl, {
              namespaceProxyOrigin: () => Effect.succeed(`http://127.0.0.1:${portOf(guest)}`),
            } as unknown as EnvironmentControl["Service"]),
          ),
        );
        const socket = yield* Socket.makeWebSocket(
          `ws://127.0.0.1:${portOf(gateway)}/api/provisioned-environment/lease-1/ws?wsTicket=guest-ticket`,
          { openTimeout: "5 seconds" },
        ).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
        const writer = yield* socket.writer;
        const { pull } = yield* socket.reader;
        yield* writer.write("ping");
        return yield* pull;
      });
      expect(echoed).toEqual(["echo:ping"]);
      expect(upstreamUrls).toEqual(["/ws?wsTicket=guest-ticket"]);
    }),
  );
});
