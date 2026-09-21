import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
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
    headers: Record<string, string>;
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
});
