import { AUTOMATION_WEBHOOK_PATH_PREFIX } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Automations } from "./Automations.ts";

/**
 * Only the first 16 KB of a body reaches the prompt. The read stops at this many bytes and the
 * request is refused, so an oversized body is never held whole.
 */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const status = (code: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status: code });

/**
 * `POST /api/automations/hooks/<token>` starts a run. The token is the whole credential, so a
 * wrong one answers 404 like any unknown path, and it is checked before the body is read.
 */
export const automationWebhookRouteLayer = HttpRouter.add(
  "POST",
  `${AUTOMATION_WEBHOOK_PATH_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return status(400, "bad_request");
    const token = url.value.pathname.slice(`${AUTOMATION_WEBHOOK_PATH_PREFIX}/`.length);
    if (!token || token.includes("/")) return status(404, "not_found");
    const automations = yield* Automations;
    const target = yield* automations.webhookTarget(token).pipe(Effect.option);
    if (Option.isNone(target)) return status(500, "internal_error");
    if (target.value.kind === "not-found") return status(404, "not_found");
    if (target.value.kind === "disabled") return status(409, "automation_disabled");
    if (Number(request.headers["content-length"]) > MAX_WEBHOOK_BODY_BYTES)
      return status(413, "payload_too_large");
    const body = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_WEBHOOK_BODY_BYTES)),
      Effect.option,
    );
    if (Option.isNone(body)) return status(413, "payload_too_large");
    const outcome = yield* automations
      .deliverWebhook(target.value.automation, {
        body: body.value,
        contentType: request.headers["content-type"],
        deliveryId: request.headers["idempotency-key"] ?? request.headers["x-github-delivery"],
      })
      .pipe(Effect.option);
    if (Option.isNone(outcome)) return status(500, "internal_error");
    if (outcome.value.kind === "rate-limited")
      return HttpServerResponse.jsonUnsafe(
        { error: "rate_limited" },
        { status: 429, headers: { "retry-after": "3600" } },
      );
    return HttpServerResponse.jsonUnsafe(
      { runId: outcome.value.run.id, state: outcome.value.run.state },
      { status: 202 },
    );
  }),
);
