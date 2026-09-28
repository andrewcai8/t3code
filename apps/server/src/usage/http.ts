import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { BoxUsageStore, importMachineUsage } from "./boxUsage.ts";
import { UsageService } from "./UsageService.ts";

/** Ninety days of hourly history from a heavy machine is about 5 MiB. */
const MAX_IMPORT_BODY_BYTES = 32 * 1024 * 1024;

export const usageImportBodyLimitLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url !== "/api/usage/import") return yield* httpEffect;
      if (Number(request.headers["content-length"]) > MAX_IMPORT_BODY_BYTES) {
        return HttpServerResponse.jsonUnsafe(
          { error: "payload_too_large", message: "Usage import exceeds 32 MiB." },
          { status: 413 },
        );
      }
      return yield* Effect.provideService(
        httpEffect,
        HttpServerRequest.MaxBodySize,
        ByteSize.bytes(MAX_IMPORT_BODY_BYTES),
      );
    }),
  { global: true },
);

export const usageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "usage",
  Effect.fnUntraced(function* (handlers) {
    const usage = yield* UsageService;
    const store = yield* BoxUsageStore;
    return handlers
      .handle(
        "history",
        Effect.fn("environment.usage.history")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* usage
            .readHistory(args.payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "import",
        Effect.fn("environment.usage.import")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* importMachineUsage(store, args.payload).pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      );
  }),
).pipe(Layer.provide(BoxUsageStore.layer));
