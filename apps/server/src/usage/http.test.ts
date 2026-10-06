import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentUsageHttpApi,
  USAGE_CONTRACT_VERSION,
  UsageDay,
  UsageImportInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NetAddress from "effect/net/NetAddress";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { failEnvironmentAuthInvalid } from "../auth/http.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { BoxUsageStore } from "./boxUsage.ts";
import { usageHttpApiLayer, usageImportBodyLimitLayer } from "./http.ts";
import * as UsageService from "./UsageService.ts";

class UsageHttpApi extends HttpApi.make("environment").add(EnvironmentUsageHttpApi) {}

const encodeImport = Schema.encodeEffect(Schema.fromJsonString(UsageImportInput));

const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;
    if (token !== "Bearer operator" && token !== "Bearer reader") {
      return yield* failEnvironmentAuthInvalid("missing_credential");
    }
    return yield* Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("usage-import-proof"),
      subject: "proof",
      method: "bearer-access-token",
      scopes: new Set([
        token === "Bearer operator" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
      ]),
    });
  }),
);

const HOME = "/Users/me/.claude/projects";

it.effect("a paired operator imports a machine's usage, and a reader cannot", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const body = yield* encodeImport({
      machineId: "mac-environment",
      history: {
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "2026-09-01T07:00:00.000Z",
        timeZone: "UTC",
        sinceDay: UsageDay.make("2026-09-01"),
        untilDay: UsageDay.make("2026-09-01"),
        buckets: [
          {
            day: UsageDay.make("2026-09-01"),
            hourStart: "2026-09-01T03:00:00.000Z",
            provider: "claude",
            model: "claude-fable-5",
            sourcePath: HOME,
            totals: {
              uncachedInputTokens: 40,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 2,
              reasoningTokens: 0,
            },
            costUsd: 1.5,
            cacheSavingsUsd: 0,
            costSource: "modelPriced",
            records: 1,
            unpricedRecords: 0,
            sessions: 1,
          },
        ],
        sources: [
          {
            fingerprint: {
              hostId: "Andrews-Mac.local",
              provider: "claude",
              resolvedHomePath: HOME,
              volumeId: "16777234:9",
            },
            status: "ok",
            scannedFiles: 1,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 1,
            message: null,
          },
        ],
        pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
        scanDurationMs: 0,
      },
    });
    const post = (credential: string) =>
      HttpClient.execute(
        HttpClientRequest.post("/api/usage/import").pipe(
          HttpClientRequest.bearerToken(credential),
          HttpClientRequest.bodyText(body, "application/json"),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          response.text.pipe(Effect.map((text) => [response.status, text] as const)),
        ),
      );

    expect((yield* post("missing"))[0]).toBe(401);
    expect((yield* post("reader"))[0]).toBe(403);
    const address = (yield* HttpServer.HttpServer).address as NetAddress.InetAddress;
    const oversized = yield* HttpClient.execute(
      HttpClientRequest.post(`http://127.0.0.1:${address.port}/api/usage/import`, {
        headers: {
          authorization: "Bearer operator",
          "content-type": "application/json",
          "content-length": String(32 * 1024 * 1024 + 1),
        },
      }),
    ).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
    expect(oversized.status).toBe(413);
    yield* oversized.text;
    expect(yield* post("operator")).toEqual([200, '{"sources":1,"buckets":1}']);

    const rows = yield* (yield* BoxUsageStore).list("", "9999", "9999");
    expect(
      rows.map((row) => [row.leaseId, row.retired, row.sources[0]?.fingerprint.hostId]),
    ).toEqual([["mac-environment", false, "Andrews-Mac.local"]]);
  }).pipe(
    Effect.provide(
      HttpRouter.serve(
        HttpApiBuilder.layer(UsageHttpApi).pipe(
          Layer.provide(usageHttpApiLayer),
          Layer.provide(Layer.mock(UsageService.UsageService)({})),
          Layer.provide(auth),
          Layer.provide(usageImportBodyLimitLayer),
        ),
        { disableListenLog: true, disableLogger: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(BoxUsageStore.layer),
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
