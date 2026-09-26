import { AUTOMATION_WEBHOOK_PATH_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as ByteSize from "effect/ByteSize";

import { Automations } from "./Automations.ts";

/** Webhook bodies beyond this are refused; only the first 16 KB reach the prompt anyway. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

const status = (code: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status: code });

/**
 * `POST /api/automations/hooks/<token>` starts a run. The token is the whole credential, so a
 * wrong one answers 404 like any unknown path.
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
    if (Number(request.headers["content-length"]) > MAX_WEBHOOK_BODY_BYTES)
      return status(413, "payload_too_large");
    const body = yield* request.text.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(MAX_WEBHOOK_BODY_BYTES)),
      Effect.option,
    );
    if (Option.isNone(body)) return status(413, "payload_too_large");
    const automations = yield* Automations;
    const outcome = yield* automations
      .webhook(token, {
        body: body.value,
        contentType: request.headers["content-type"],
        deliveryId: request.headers["idempotency-key"] ?? request.headers["x-github-delivery"],
      })
      .pipe(Effect.option);
    if (Option.isNone(outcome)) return status(500, "internal_error");
    switch (outcome.value.kind) {
      case "started":
        return HttpServerResponse.jsonUnsafe(
          { runId: outcome.value.run.id, state: outcome.value.run.state },
          { status: 202 },
        );
      case "not-found":
        return status(404, "not_found");
      case "disabled":
        return status(409, "automation_disabled");
      case "rate-limited":
        return HttpServerResponse.jsonUnsafe(
          { error: "rate_limited" },
          { status: 429, headers: { "retry-after": "3600" } },
        );
    }
  }),
);
