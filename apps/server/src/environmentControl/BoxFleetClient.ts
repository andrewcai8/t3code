/**
 * BoxFleetClient - the host's fleet RPC connection to one of its cloud boxes.
 *
 * The host reaches a box with the box's broker token, the admin credential it
 * minted when it prepared the box. It trades that token for a WebSocket
 * ticket, then speaks the same `fleet.*` RPCs a desktop window speaks to the
 * server it relays for.
 *
 * @module BoxFleetClient
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  type FleetHostRegistration,
  type ProvisionedChat,
  type FleetHostRequest,
  type FleetHostResponse,
  type FleetInvokeInput,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { boxOrchestrationHeaders } from "./leaseActivity.ts";
import type { RemoteAccess } from "./ProvisionedLeaseRegistry.ts";
import { ownerChat } from "./provisionedChats.ts";

export class BoxUnreachableError extends Schema.TaggedError<BoxUnreachableError>()(
  "BoxUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The cloud box at ${this.origin} could not be reached.`;
  }
}

/** One open connection to a box, as its fleet host. */
export interface BoxFleetConnection {
  /** Registers as the box's fleet host; the box sends its chats' requests on the stream. */
  readonly connect: (
    registration: FleetHostRegistration,
  ) => Stream.Stream<FleetHostRequest, BoxUnreachableError>;
  readonly respond: (response: FleetHostResponse) => Effect.Effect<void, BoxUnreachableError>;
  /** Runs one fleet operation on the box; its own failures pass through. */
  readonly invoke: (
    input: FleetInvokeInput,
  ) => Effect.Effect<unknown, OrchestratorMcpFailure | BoxUnreachableError>;
}

export class BoxFleetClient extends Context.Service<
  BoxFleetClient,
  {
    /** Opens a connection to the box at `access`; it closes with the scope. */
    readonly open: (
      access: RemoteAccess,
    ) => Effect.Effect<BoxFleetConnection, BoxUnreachableError, Scope.Scope>;
    /**
     * The chat `ownerThreadId` as the box's shell shows it now. Null when the shell holds no such
     * chat or cannot be read as one.
     */
    readonly readChat: (
      access: RemoteAccess,
      ownerThreadId: string,
    ) => Effect.Effect<ProvisionedChat | null, BoxUnreachableError>;
  }
>()("t3/environmentControl/BoxFleetClient") {}

const Ticket = Schema.Struct({ ticket: TrimmedNonEmptyString });
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const open = Effect.fn("BoxFleetClient.open")(function* (access: RemoteAccess) {
    const unreachable = (cause: unknown) =>
      new BoxUnreachableError({ origin: access.origin, cause });
    const { ticket } = yield* httpClient
      .execute(
        HttpClientRequest.post(`${access.origin}/api/auth/websocket-ticket`).pipe(
          HttpClientRequest.bearerToken(access.brokerToken),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Ticket)),
        Effect.timeout("10 seconds"),
        Effect.mapError(unreachable),
      );
    const socketUrl = new URL("/ws", access.origin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("wsTicket", ticket);
    socketUrl.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    // A dropped connection is not retried here: the host reconnects on its next pass.
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(socketUrl.toString(), { openTimeout: "15 seconds" }).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
    return {
      connect: (registration) =>
        client["fleet.connect"](registration).pipe(Stream.mapError(unreachable)),
      respond: (response) => client["fleet.respond"](response).pipe(Effect.mapError(unreachable)),
      invoke: (input) =>
        client["fleet.invoke"](input).pipe(
          Effect.mapError((error) => (isMcpFailure(error) ? error : unreachable(error))),
        ),
    } satisfies BoxFleetConnection;
  });
  const readChat = Effect.fn("BoxFleetClient.readChat")(function* (
    access: RemoteAccess,
    ownerThreadId: string,
  ) {
    const body = yield* httpClient
      .execute(
        HttpClientRequest.get(`${access.origin}/api/orchestration/shell`).pipe(
          HttpClientRequest.setHeaders(boxOrchestrationHeaders(access)),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new BoxUnreachableError({ origin: access.origin, cause })),
      );
    return ownerChat(body, ownerThreadId) ?? null;
  });
  return BoxFleetClient.of({ open, readChat });
});

export const layer = Layer.effect(BoxFleetClient, make);
