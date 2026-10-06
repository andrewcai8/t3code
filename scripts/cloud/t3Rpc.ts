import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WsRpcGroup,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import { PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const wsUrl = (httpBaseUrl: string) => {
  const url = new URL("ws", httpBaseUrl.endsWith("/") ? httpBaseUrl : `${httpBaseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  return url.toString();
};

const makeClient = RpcClient.make(WsRpcGroup);
export type T3Client =
  typeof makeClient extends Effect.Effect<infer C, infer _E, infer _R> ? C : never;

const decodeWebSocketTicket = Schema.decodeUnknownEffect(
  Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket }),
);
const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);

/**
 * Runs `use` with an RPC client whose socket closes when `use` finishes. Every connection, the
 * first and each reconnect, authenticates with a fresh ticket in its URL as the web client does:
 * the manager's gateway to a Namespace box forwards the upgrade URL but not its headers.
 */
export const withRpc = <A, E, R>(
  httpBaseUrl: string,
  bearer: string,
  use: (client: T3Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const connectUrl = http
      .execute(
        HttpClientRequest.post(new URL("api/auth/websocket-ticket", httpBaseUrl)).pipe(
          HttpClientRequest.bearerToken(bearer),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeWebSocketTicket),
        Effect.map(({ ticket }) => {
          const url = new URL(wsUrl(httpBaseUrl));
          url.searchParams.set("wsTicket", ticket);
          return url.toString();
        }),
        Effect.timeout("2 minutes"),
        // Without a ticket the server refuses the upgrade, which the RPC client reports as a
        // socket error on the call that needed it.
        Effect.orElseSucceed(() => wsUrl(httpBaseUrl)),
      );
    return yield* makeClient.pipe(
      Effect.flatMap(use),
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(connectUrl).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
          ),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
      Effect.scoped,
    );
  });

export const exchangePairingToken = Effect.fn("exchangePairingToken")(function* (
  httpBaseUrl: string,
  credential: string,
  clientLabel: string,
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* http.execute(
    HttpClientRequest.post(new URL("oauth/token", httpBaseUrl)).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: clientLabel,
        client_device_type: "bot",
      }),
    ),
  );
  return yield* decodeAccessToken(yield* response.json);
});

/**
 * The URL a script pairs with a box from: the box's own pairing URL, or, when that names a
 * loopback address, the same pairing request through the manager's guest gateway.
 */
export const childPairingUrl = (input: {
  readonly attachedPairingUrl: URL;
  readonly origin: string;
  readonly leaseId: string;
}) => {
  const gateway = isLoopbackHost(input.attachedPairingUrl.hostname);
  if (!gateway) return { pairingUrl: input.attachedPairingUrl.toString(), gateway };
  return {
    pairingUrl: Object.assign(new URL(input.origin), {
      pathname: `${PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX}/${encodeURIComponent(input.leaseId)}/pair`,
      search: input.attachedPairingUrl.search,
      hash: input.attachedPairingUrl.hash,
    }).toString(),
    gateway,
  };
};
