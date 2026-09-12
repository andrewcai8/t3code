import * as NodeHttp from "node:http";
import { describe, expect, it } from "vitest";
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
  it("forwards query and streaming response with sanitized headers", async () => {
    const seen: { url?: string; headers?: NodeHttp.IncomingHttpHeaders } = {};
    const upstream = await listen((request, response) => {
      seen.url = request.url;
      seen.headers = request.headers;
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("a");
      setTimeout(() => {
        response.end("b");
      }, 1);
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
    expect(seen.headers?.authorization).toBe("Bearer secret");
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
