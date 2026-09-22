import { PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { proxyWebSocket } from "../httpWebSocketProxy.ts";
import * as EnvironmentControl from "./EnvironmentControl.ts";

/** Headers owned by the manager transport and never presented to a guest T3 server. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "cookie",
  "dpop",
]);

const PROVISIONED_ENVIRONMENT_ROUTE_PREFIX = PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX;

const isWebSocketUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket";

export const forwardedHeaders = (request: HttpServerRequest.HttpServerRequest) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
};

export const resolveProvisionedEnvironmentTarget = (
  url: URL,
  origin: string,
): { leaseId: string; target: URL } | null => {
  const prefix = `${PROVISIONED_ENVIRONMENT_ROUTE_PREFIX}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  const separator = rest.indexOf("/");
  const encodedLeaseId = separator === -1 ? rest : rest.slice(0, separator);
  if (!encodedLeaseId) return null;
  let leaseId: string;
  try {
    leaseId = decodeURIComponent(encodedLeaseId);
  } catch {
    return null;
  }
  const suffix = separator === -1 ? "/" : rest.slice(separator) || "/";
  let target: URL;
  try {
    target = new URL(origin);
  } catch {
    return null;
  }
  target.pathname = suffix;
  target.search = url.search;
  return { leaseId, target };
};

const proxyHttp = Effect.fn("ProvisionedEnvironmentGateway.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  target: URL,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const upstreamRequest = HttpClientRequest.make(method)(target.toString()).pipe(
    method === "GET" || method === "HEAD"
      ? (self) => self
      : HttpClientRequest.bodyStream(request.stream),
    HttpClientRequest.setHeaders(forwardedHeaders(request)),
  );
  const response = yield* httpClient.execute(upstreamRequest);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (name === "content-encoding" || name === "transfer-encoding" || name === "connection") {
      continue;
    }
    if (value !== undefined) headers[name] = value;
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const route = resolveProvisionedEnvironmentTarget(url.value, "http://invalid");
  if (!route) return HttpServerResponse.text("Not Found", { status: 404 });
  const control = yield* EnvironmentControl.EnvironmentControl;
  const origin = yield* control
    .namespaceProxyOrigin(route.leaseId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!origin) return HttpServerResponse.text("Not Found", { status: 404 });
  const resolved = resolveProvisionedEnvironmentTarget(url.value, origin);
  if (!resolved) return HttpServerResponse.text("Not Found", { status: 404 });
  if (isWebSocketUpgrade(request))
    return yield* proxyWebSocket(request, resolved.target.toString().replace(/^http/, "ws"));
  return yield* proxyHttp(request, resolved.target).pipe(
    Effect.catch(() => Effect.succeed(HttpServerResponse.text("Bad Gateway", { status: 502 }))),
  );
});

export const provisionedEnvironmentGatewayRouteLayer = HttpRouter.add(
  "*",
  `${PROVISIONED_ENVIRONMENT_ROUTE_PREFIX}/*`,
  handler,
);
