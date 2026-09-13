// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - this local listener owns the Node HTTP boundary and fetches its private upstream.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";

export interface NamespaceProxyLease {
  readonly proxyId: string;
  readonly proxyOrigin: string;
}

export interface NamespaceProxyOpenInput {
  readonly proxyId: string;
  readonly upstreamHttpBaseUrl: string;
  readonly upstreamWsBaseUrl: string;
  readonly upstreamAuthorization: string;
}

type StoredLease = NamespaceProxyOpenInput & {
  readonly server: NodeHttp.Server;
  readonly proxyOrigin: string;
  readonly sockets: Set<NodeStream.Duplex>;
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
const FETCH_DECODED = new Set(["content-encoding", "content-length"]);
const copyHeaders = (
  headers: NodeHttp.IncomingHttpHeaders,
  authorization?: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (authorization) result["x-nsc-ingress-auth"] = authorization;
  return result;
};

const joinUrl = (base: string, requestUrl: string): URL => {
  const origin = new URL(base);
  const path = requestUrl.startsWith("/") ? requestUrl : `/${requestUrl}`;
  return new URL(path, origin);
};

export class NamespaceProxyManager {
  private readonly leases = new Map<string, StoredLease>();

  async open(input: NamespaceProxyOpenInput): Promise<NamespaceProxyLease> {
    return this.bind(input, 0);
  }

  async restore(
    input: NamespaceProxyOpenInput & NamespaceProxyLease,
  ): Promise<NamespaceProxyLease> {
    const origin = new URL(input.proxyOrigin);
    const port = Number(origin.port);
    if (
      origin.protocol !== "http:" ||
      origin.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      origin.origin !== input.proxyOrigin
    )
      throw new Error("Namespace proxy origin must be a loopback HTTP origin with a port");
    const existing = this.leases.get(input.proxyId);
    if (existing) {
      if (existing.proxyOrigin !== input.proxyOrigin)
        throw new Error("Namespace proxy origin does not match its retained lease");
      this.leases.set(input.proxyId, { ...existing, ...input });
      return { proxyId: input.proxyId, proxyOrigin: input.proxyOrigin };
    }
    return this.bind(input, port);
  }

  private async bind(input: NamespaceProxyOpenInput, port: number): Promise<NamespaceProxyLease> {
    if (this.leases.has(input.proxyId))
      throw new Error(`Namespace proxy already exists: ${input.proxyId}`);
    const server = NodeHttp.createServer((request, response) => {
      const lease = this.leases.get(input.proxyId);
      if (lease) void this.forwardHttp(lease, request, response);
      else response.writeHead(404).end();
    });
    const lease: StoredLease = { ...input, server, proxyOrigin: "", sockets: new Set() };
    this.leases.set(input.proxyId, lease);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Namespace proxy did not receive a port");
      const proxyOrigin = `http://127.0.0.1:${address.port}`;
      const stored = { ...lease, proxyOrigin };
      this.leases.set(input.proxyId, stored);
      server.on("upgrade", (request, socket) => {
        const current = this.leases.get(input.proxyId);
        if (!current) {
          socket.destroy();
          return;
        }
        stored.sockets.add(socket);
        socket.once("close", () => stored.sockets.delete(socket));
        this.forwardWebSocket(current, request, socket);
      });
      return { proxyId: input.proxyId, proxyOrigin };
    } catch (error) {
      this.leases.delete(input.proxyId);
      server.close();
      throw error;
    }
  }

  async close(input: { readonly proxyId: string }): Promise<void> {
    const lease = this.leases.get(input.proxyId);
    if (!lease) return;
    this.leases.delete(input.proxyId);
    for (const socket of lease.sockets) socket.destroy();
    lease.server.closeAllConnections();
    await new Promise<void>((resolve) => lease.server.close(() => resolve()));
  }

  private async forwardHttp(
    lease: StoredLease,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): Promise<void> {
    try {
      const target = joinUrl(lease.upstreamHttpBaseUrl, request.url ?? "/");
      const method = request.method ?? "GET";
      const requestInit: RequestInit = {
        method,
        headers: copyHeaders(request.headers, lease.upstreamAuthorization),
      };
      if (method !== "GET" && method !== "HEAD") {
        requestInit.body = request;
        requestInit.duplex = "half";
      }
      const upstream = await fetch(target, requestInit);
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name) && !FETCH_DECODED.has(name)) responseHeaders[name] = value;
      });
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        for await (const chunk of NodeStream.Readable.fromWeb(upstream.body)) response.write(chunk);
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end("Namespace upstream unavailable");
    }
  }

  private forwardWebSocket(
    lease: StoredLease,
    request: NodeHttp.IncomingMessage,
    client: NodeStream.Duplex,
  ): void {
    const target = new URL(joinUrl(lease.upstreamWsBaseUrl, request.url ?? "/"));
    const port = Number(target.port || (target.protocol === "wss:" ? 443 : 80));
    const connect =
      target.protocol === "wss:"
        ? NodeTls.connect({ host: target.hostname, port, servername: target.hostname })
        : NodeNet.connect(port, target.hostname);
    const readyEvent = target.protocol === "wss:" ? "secureConnect" : "connect";
    connect.once(readyEvent, () => {
      const headers = copyHeaders(request.headers, lease.upstreamAuthorization);
      headers.host = target.host;
      headers.connection = "Upgrade";
      headers.upgrade = "websocket";
      const lines = [
        `${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/1.1`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ];
      connect.write(lines.join("\r\n"));
      client.pipe(connect).pipe(client);
    });
    connect.once("error", () => client.destroy());
    client.once("error", () => connect.destroy());
  }
}
