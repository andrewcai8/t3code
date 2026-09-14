// @effect-diagnostics nodeBuiltinImport:off - the persistence boundary hashes canonical immutable requests.
import * as NodeCrypto from "node:crypto";
import {
  DurableProvisionRequest,
  ProvisionOperation,
  ProvisionOperationState,
  ProvisionRequestConflict,
  type ProvisionRequestId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class ProvisionStoreError extends Schema.TaggedError<ProvisionStoreError>()(
  "ProvisionStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}
const Row = Schema.Struct({
  ...ProvisionOperation.fields,
  request: Schema.fromJsonString(DurableProvisionRequest),
  state: Schema.fromJsonString(ProvisionOperationState),
});
const decodeRow = Schema.decodeUnknownEffect(Row);
const decodeRequest = Schema.decodeUnknownEffect(DurableProvisionRequest);
const encodeState = Schema.encodeSync(Schema.fromJsonString(ProvisionOperationState));

export class ProvisionOperationStore extends Context.Service<
  ProvisionOperationStore,
  {
    readonly accept: (
      request: DurableProvisionRequest,
    ) => Effect.Effect<ProvisionOperation, ProvisionStoreError | ProvisionRequestConflict>;
    readonly get: (
      requestId: ProvisionRequestId,
    ) => Effect.Effect<ProvisionOperation, ProvisionStoreError>;
    readonly advance: (
      current: ProvisionOperation,
      state: ProvisionOperationState,
    ) => Effect.Effect<
      {
        readonly changed: boolean;
        readonly operation: ProvisionOperation;
      },
      ProvisionStoreError
    >;
  }
>()("t3/environmentControl/ProvisionOperationStore") {
  static readonly layer = Layer.effect(
    ProvisionOperationStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const get = Effect.fn("ProvisionOperationStore.get")(
        function* (requestId: ProvisionRequestId) {
          const rows = yield* sql`
        SELECT request_json AS request, request_hash AS "requestHash", state_json AS state,
          revision, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM provision_operations WHERE request_id = ${requestId}
      `;
          return yield* decodeRow(rows[0]);
        },
        Effect.mapError((cause) => new ProvisionStoreError({ operation: "read", cause })),
      );
      const accept = Effect.fn("ProvisionOperationStore.accept")(function* (
        input: DurableProvisionRequest,
      ) {
        const request = yield* decodeRequest(input).pipe(
          Effect.mapError(
            (cause) => new ProvisionStoreError({ operation: "decode_request", cause }),
          ),
        );
        const body = stableStringify(request);
        const requestHash = NodeCrypto.createHash("sha256").update(body).digest("hex");
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
        INSERT INTO provision_operations (request_id, request_hash, request_json, state_json, revision, created_at, updated_at)
        VALUES (${request.requestId}, ${requestHash}, ${body}, ${encodeState({ kind: "intent" })}, 0, ${now}, ${now})
        ON CONFLICT(request_id) DO NOTHING
      `.pipe(Effect.mapError((cause) => new ProvisionStoreError({ operation: "accept", cause })));
        const stored = yield* get(request.requestId);
        if (stored.requestHash !== requestHash)
          return yield* new ProvisionRequestConflict({ requestId: request.requestId });
        return stored;
      });
      const advance = Effect.fn("ProvisionOperationStore.advance")(
        function* (current: ProvisionOperation, state: ProvisionOperationState) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const rows = yield* sql`
        UPDATE provision_operations SET state_json = ${encodeState(state)}, revision = revision + 1, updated_at = ${now}
        WHERE request_id = ${current.request.requestId} AND revision = ${current.revision} AND request_hash = ${current.requestHash}
        RETURNING request_json AS request, request_hash AS "requestHash", state_json AS state,
          revision, created_at AS "createdAt", updated_at AS "updatedAt"
      `;
          const row = rows[0];
          return {
            changed: row !== undefined,
            operation:
              row === undefined ? yield* get(current.request.requestId) : yield* decodeRow(row),
          };
        },
        Effect.mapError((cause) => new ProvisionStoreError({ operation: "advance", cause })),
      );
      return { accept, get, advance };
    }),
  );
}
