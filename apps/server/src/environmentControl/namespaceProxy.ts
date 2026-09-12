import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { Readable as NodeReadable } from "node:stream";

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
  "authorization",
  "cookie",
]);
const copyHeaders = (
  headers: NodeHttp.IncomingHttpHeaders,
  authorization?: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (authorization) result.authorization = authorization;
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
    if (this.leases.has(input.proxyId))
      throw new Error(`Namespace proxy already exists: ${input.proxyId}`);
    const server = NodeHttp.createServer((request, response) => {
      void this.forwardHttp(input, request, response);
    });
    const lease: StoredLease = { ...input, server, proxyOrigin: "" };
    this.leases.set(input.proxyId, lease);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Namespace proxy did not receive a port");
      const proxyOrigin = `http://127.0.0.1:${address.port}`;
      const stored = { ...lease, proxyOrigin };
      this.leases.set(input.proxyId, stored);
      server.on("upgrade", (request, socket) => this.forwardWebSocket(stored, request, socket));
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
    await new Promise<void>((resolve) => lease.server.close(() => resolve()));
  }

  private async forwardHttp(
    lease: StoredLease,
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ): Promise<void> {
    try {
      const target = joinUrl(lease.upstreamHttpBaseUrl, request.url ?? "/");
      const upstream = await fetch(target, {
        method: request.method,
        headers: copyHeaders(request.headers, lease.upstreamAuthorization),
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request,
      });
      const responseHeaders: Record<string, string> = {};
      upstream.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value;
      });
      response.writeHead(upstream.status, responseHeaders);
      if (upstream.body) {
        for await (const chunk of NodeReadable.fromWeb(upstream.body)) response.write(chunk);
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
    client: NodeNet.Socket,
  ): void {
    const target = new URL(joinUrl(lease.upstreamWsBaseUrl, request.url ?? "/"));
    const port = Number(target.port || (target.protocol === "wss:" ? 443 : 80));
    const connect =
      target.protocol === "wss:"
        ? NodeTls.connect({ host: target.hostname, port, servername: target.hostname })
        : NodeNet.connect(port, target.hostname);
    connect.once("connect", () => {
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
