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
      getUpstreamAuthorization: async () => "Bearer secret",
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
    expect(seen.headers?.cookie).toBe("session=x");
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
      getUpstreamAuthorization: async () => "Bearer x",
    };
    await manager.open(input);
    await expect(manager.open(input)).rejects.toThrow("already exists");
    await manager.close({ proxyId: "same" });
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });
});

describe("Namespace proxy restoration", () => {
  it("keeps the saved T3 bearer session authenticated after restoration", async () => {
    const upstream = await listen((request, response) => {
      if (request.headers.authorization !== "Bearer saved-t3-session") {
        response.writeHead(401).end("Unauthorized");
        return;
      }
      if (request.headers["x-nsc-ingress-auth"] !== "Bearer namespace-ingress") {
        response.writeHead(403).end("Missing ingress authentication");
        return;
      }
      response.end("retained-environment");
    });
    const manager = new NamespaceProxyManager();
    const restarted = new NamespaceProxyManager();
    const input = {
      proxyId: "authenticated",
      upstreamHttpBaseUrl: upstream.origin,
      upstreamWsBaseUrl: upstream.origin.replace("http", "ws"),
      getUpstreamAuthorization: async () => "Bearer namespace-ingress",
    };
    try {
      const lease = await manager.open(input);
      await manager.close(lease);
      await restarted.restore({ ...input, ...lease });
      const response = await fetch(`${lease.proxyOrigin}/api/auth/session`, {
        headers: { authorization: "Bearer saved-t3-session", connection: "close" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("retained-environment");
    } finally {
      await manager.close(input);
      await restarted.close(input);
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
    }
  });
  it("updates a live proxy and rebinds its saved origin after manager restart", async () => {
    const first = await listen((_request, response) => response.end("first"));
    const second = await listen((request, response) =>
      response.end(`second:${request.headers["x-nsc-ingress-auth"]}`),
    );
    const manager = new NamespaceProxyManager();
    const restarted = new NamespaceProxyManager();
    const input = {
      proxyId: "retained",
      upstreamHttpBaseUrl: first.origin,
      upstreamWsBaseUrl: first.origin.replace("http", "ws"),
      getUpstreamAuthorization: async () => "old",
    };
    try {
      const lease = await manager.open(input);
      const restoredInput = {
        ...input,
        ...lease,
        upstreamHttpBaseUrl: second.origin,
        upstreamWsBaseUrl: second.origin.replace("http", "ws"),
        getUpstreamAuthorization: async () => "new",
      };
      expect(
        await (await fetch(lease.proxyOrigin, { headers: { connection: "close" } })).text(),
      ).toBe("first");
      expect(await manager.restore(restoredInput)).toEqual(lease);
      expect(
        await (await fetch(lease.proxyOrigin, { headers: { connection: "close" } })).text(),
      ).toBe("second:new");
      await manager.close(lease);
      expect(await restarted.restore(restoredInput)).toEqual(lease);
      expect(
        await (await fetch(lease.proxyOrigin, { headers: { connection: "close" } })).text(),
      ).toBe("second:new");
    } finally {
      await manager.close(input);
      await restarted.close(input);
      await Promise.all(
        [first, second].map(
          ({ server }) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    }
  });

  it("refuses an occupied saved port", async () => {
    const occupied = await listen((_request, response) => response.end("occupied"));
    const manager = new NamespaceProxyManager();
    try {
      await expect(
        manager.restore({
          proxyId: "retained",
          proxyOrigin: occupied.origin,
          upstreamHttpBaseUrl: occupied.origin,
          upstreamWsBaseUrl: occupied.origin.replace("http", "ws"),
          getUpstreamAuthorization: async () => "token",
        }),
      ).rejects.toThrow("EADDRINUSE");
      expect(await (await fetch(occupied.origin)).text()).toBe("occupied");
    } finally {
      await new Promise<void>((resolve) => occupied.server.close(() => resolve()));
    }
  });
});

const upgrade = (origin: string) =>
  new Promise<void>((resolve, reject) => {
    const request = NodeHttp.request(origin, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        authorization: "Bearer saved-t3-session",
      },
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve();
    });
    request.once("error", reject);
    request.end();
  });

it("renews ingress authorization for HTTP requests and WebSocket handshakes", async () => {
  const received: string[] = [];
  const upstream = await listen((request, response) => {
    response.end(`${request.headers["x-nsc-ingress-auth"]}:${request.headers.authorization}`);
  });
  upstream.server.on("upgrade", (request, socket) => {
    received.push(`${request.headers["x-nsc-ingress-auth"]}:${request.headers.authorization}`);
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  let authorization = "Bearer first";
  const manager = new NamespaceProxyManager();
  const lease = await manager.open({
    proxyId: "renewable",
    upstreamHttpBaseUrl: upstream.origin,
    upstreamWsBaseUrl: upstream.origin.replace("http", "ws"),
    getUpstreamAuthorization: async () => authorization,
  });
  try {
    for (const token of ["Bearer first", "Bearer renewed"]) {
      authorization = token;
      const response = await fetch(lease.proxyOrigin, {
        headers: { authorization: "Bearer saved-t3-session", connection: "close" },
      });
      expect(await response.text()).toBe(`${token}:Bearer saved-t3-session`);
      await upgrade(lease.proxyOrigin);
    }
    expect(received).toEqual([
      "Bearer first:Bearer saved-t3-session",
      "Bearer renewed:Bearer saved-t3-session",
    ]);
  } finally {
    await manager.close(lease);
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

it("fails closed on HTTP and WebSocket auth errors and recovers on the next request", async () => {
  let upstreamRequests = 0;
  const upstream = await listen((_request, response) => {
    upstreamRequests++;
    response.end("authenticated");
  });
  let fail = true;
  const manager = new NamespaceProxyManager();
  const lease = await manager.open({
    proxyId: "auth-failure",
    upstreamHttpBaseUrl: upstream.origin,
    upstreamWsBaseUrl: upstream.origin.replace("http", "ws"),
    getUpstreamAuthorization: async () => {
      if (fail) throw new Error("private credential failure");
      return "Bearer renewed";
    },
  });
  try {
    const response = await fetch(lease.proxyOrigin, { headers: { connection: "close" } });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Namespace upstream unavailable");
    await expect(upgrade(lease.proxyOrigin)).rejects.toThrow();
    expect(upstreamRequests).toBe(0);
    fail = false;
    expect(
      await (await fetch(lease.proxyOrigin, { headers: { connection: "close" } })).text(),
    ).toBe("authenticated");
    expect(upstreamRequests).toBe(1);
  } finally {
    await manager.close(lease);
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});
