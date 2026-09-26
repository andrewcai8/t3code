import { AUTOMATION_WEBHOOK_PATH_PREFIX } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { Automations } from "./Automations.ts";

/** Only the first 16 KB of a body reaches the prompt; a body over this is refused. */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/**
 * An oversized body up to this size is read and dropped, so a caller that sends it whole gets its
 * 413. Past it the read stops and the connection is closed, so no sender can hold a handler.
 */
const MAX_DRAINED_BODY_BYTES = 1024 * 1024;

type BodyRead =
  | { readonly kind: "body"; readonly text: string }
  | { readonly kind: "too-large"; readonly drained: boolean };

/**
 * Reads a body, keeping at most `MAX_WEBHOOK_BODY_BYTES`. `MaxBodySize` does not bound
 * `request.stream` on Node, so the fold counts bytes itself and stops past the drain limit.
 */
const readBoundedBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ kept: [] as Array<Uint8Array>, size: 0 }),
      (read, chunk) => {
        const size = read.size + chunk.length;
        if (size > MAX_DRAINED_BODY_BYTES) return Effect.fail("too-large" as const);
        if (size <= MAX_WEBHOOK_BODY_BYTES) read.kept.push(chunk);
        return Effect.succeed({ kept: read.kept, size });
      },
    ),
    Effect.map(({ kept, size }): BodyRead =>
      size > MAX_WEBHOOK_BODY_BYTES
        ? { kind: "too-large", drained: true }
        : { kind: "body", text: Buffer.concat(kept).toString("utf8") },
    ),
    Effect.orElseSucceed((): BodyRead => ({ kind: "too-large", drained: false })),
  );

const tooLarge = (drained: boolean) =>
  HttpServerResponse.jsonUnsafe(
    { error: "payload_too_large" },
    { status: 413, ...(drained ? {} : { headers: { connection: "close" } }) },
  );

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
    if (Number(request.headers["content-length"]) > MAX_DRAINED_BODY_BYTES) return tooLarge(false);
    const body = yield* readBoundedBody(request);
    if (body.kind === "too-large") return tooLarge(body.drained);
    const outcome = yield* automations
      .deliverWebhook(target.value.automation, {
        body: body.text,
        contentType: request.headers["content-type"],
        deliveryId: request.headers["idempotency-key"] ?? request.headers["x-github-delivery"],
      })
      .pipe(Effect.option);
    if (Option.isNone(outcome)) return status(500, "internal_error");
    if (outcome.value.kind === "not-found") return status(404, "not_found");
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
