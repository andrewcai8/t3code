// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this test drives a real local HTTP boundary.
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { NamespaceProxyManager } from "./namespaceProxy.ts";

const listen = (handler: NodeHttp.RequestListener) =>
  new Promise<{ server: NodeHttp.Server; origin: string }>((resolve) => {
    const server = NodeHttp.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      resolve({ server, origin: `http://127.0.0.1:${address.port}` });
    });
  });

describe("NamespaceProxyManager", () => {
  it("keeps ingress credentials on the configured upstream across paths and redirects", async () => {
    const escapedRequests: string[] = [];
    const escaped = await listen((request, response) => {
      escapedRequests.push(request.headers["x-nsc-ingress-auth"]?.toString() ?? "missing");
      response.end("escaped");
    });
    const upstream = await listen((_request, response) => {
      response.writeHead(302, { location: `${escaped.origin}/redirected` });
      response.end();
    });
    const manager = new NamespaceProxyManager();
    try {
      const lease = await manager.open({
        proxyId: "restricted-origin",
        upstreamHttpBaseUrl: upstream.origin,
        upstreamWsBaseUrl: upstream.origin.replace("http", "ws"),
        upstreamAuthorization: "Bearer private-ingress",
      });
      const statuses: Array<number | undefined> = [];
      for (const path of [`//${new URL(escaped.origin).host}/path`, "/redirect"]) {
        statuses.push(
          await new Promise<number | undefined>((resolve, reject) => {
            const request = NodeHttp.get(lease.proxyOrigin, { path }, (response) => {
              response.resume();
              response.once("end", () => resolve(response.statusCode));
            });
            request.once("error", reject);
          }),
        );
      }
      expect(escapedRequests).toEqual([]);
      expect(statuses).toEqual([502, 302]);
    } finally {
      await manager.close({ proxyId: "restricted-origin" });
      for (const { server } of [upstream, escaped]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it("forwards query and streaming response with sanitized headers", async () => {
    const seen: { url: string | undefined; headers: NodeHttp.IncomingHttpHeaders | undefined } = {
      url: undefined,
      headers: undefined,
    };
    const upstream = await listen((request, response) => {
      seen.url = request.url;
      seen.headers = request.headers;
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("a");
      queueMicrotask(() => response.end("b"));
    });
    const manager = new NamespaceProxyManager();
    const lease = await manager.open({
      proxyId: "p1",
      upstreamHttpBaseUrl: upstream.origin,
      upstreamWsBaseUrl: upstream.origin.replace("http", "ws"),
      upstreamAuthorization: "Bearer secret",
    });
    const response = await fetch(`${lease.proxyOrigin}/api/run?q=1`, {
      headers: {
        host: "evil",
        authorization: "Bearer client",
        cookie: "session=x",
        connection: "keep-alive",
      },
    });
    expect(await response.text()).toBe("ab");
    expect(seen.url).toBe("/api/run?q=1");
    expect(seen.headers?.["x-nsc-ingress-auth"]).toBe("Bearer secret");
    expect(seen.headers?.authorization).toBe("Bearer client");
    expect(seen.headers?.cookie).toBeUndefined();
    expect(seen.headers?.host).not.toBe("evil");
    await manager.close({ proxyId: "p1" });
    await manager.close({ proxyId: "p1" });
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  it("rejects duplicate proxy ids", async () => {
    const upstream = await listen((_request, response) => response.end("ok"));
    const manager = new NamespaceProxyManager();
    const input = {
      proxyId: "same",
      upstreamHttpBaseUrl: upstream.origin,
      upstreamWsBaseUrl: upstream.origin.replace("http", "ws"),
      upstreamAuthorization: "Bearer x",
    };
    await manager.open(input);
    await expect(manager.open(input)).rejects.toThrow("already exists");
    await manager.close({ proxyId: "same" });
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });
});
