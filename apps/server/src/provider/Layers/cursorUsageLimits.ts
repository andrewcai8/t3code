import * as NodeOS from "node:os";
import { CURSOR_MONTHLY_WINDOW_ID, type CursorSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const CursorCredentials = Schema.Struct({ accessToken: Schema.optional(Schema.String) });
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(CursorCredentials));
const CursorUsageResponse = Schema.Struct({
  billingCycleStart: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  billingCycleEnd: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  planUsage: Schema.optional(Schema.Struct({ autoPercentUsed: Schema.optional(Schema.Number) })),
});

/**
 * Cursor's monthly allowance is its included Auto pool. The API pool can read
 * 100% while Auto turns still succeed, so it is not reported. Dashboard
 * percentages include bonus usage; spend / limit does not.
 */
export function cursorUsageResponseToLimits(
  response: typeof CursorUsageResponse.Type,
  checkedAt: string,
) {
  const usedPercent = response.planUsage?.autoPercentUsed;
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  }
  const start = Number(response.billingCycleStart);
  const end = Number(response.billingCycleEnd);
  const reset = DateTime.make(end);
  const resetsAt = end > 0 && Option.isSome(reset) ? DateTime.formatIso(reset.value) : undefined;
  const windowDurationMins = start > 0 && end > start ? Math.round((end - start) / 60_000) : 0;
  return makeUsageLimits({
    checkedAt,
    windows: [
      {
        id: CURSOR_MONTHLY_WINDOW_ID,
        kind: "monthly",
        label: "Monthly usage",
        usedPercent: clampPercent(usedPercent),
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowDurationMins > 0 ? { windowDurationMins } : {}),
      },
    ],
  });
}

export const readCursorUsageLimits = Effect.fn("readCursorUsageLimits")(function* (
  settings: Pick<CursorSettings, "apiEndpoint">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    // An explicit API key can name a different account from the stored login.
    if (!token && environment.CURSOR_API_KEY?.trim()) {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    const credentialStore = environment.AGENT_CLI_CREDENTIAL_STORE;
    if (
      !token &&
      (credentialStore === "memory" || (platform === "darwin" && credentialStore !== "file"))
    ) {
      // Cursor's default macOS login lives in the keychain; a leftover file may be another account.
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Cursor usage requires a file-based login or CURSOR_AUTH_TOKEN.",
      });
    }
    if (!token) {
      const home =
        (platform === "win32" ? environment.USERPROFILE : environment.HOME) || NodeOS.homedir();
      const directory =
        platform === "win32"
          ? path.join(environment.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor")
          : platform === "darwin"
            ? path.join(home, ".cursor")
            : path.join(environment.XDG_CONFIG_HOME || path.join(home, ".config"), "cursor");
      const credentials = yield* fs.readFileString(path.join(directory, "auth.json")).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
        }),
        Effect.flatMap(decodeCredentials),
      );
      token = credentials.accessToken?.trim();
    }
    if (!token) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const client = yield* HttpClient.HttpClient;
    const endpoint = (
      settings.apiEndpoint.trim() ||
      environment.CURSOR_API_ENDPOINT?.trim() ||
      "https://api2.cursor.sh"
    ).replace(/\/$/, "");
    const response = yield* client.execute(
      HttpClientRequest.post(`${endpoint}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          "connect-protocol-version": "1",
          "x-cursor-client-type": "cli",
        }),
        HttpClientRequest.bodyJsonUnsafe({}),
      ),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(CursorUsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return cursorUsageResponseToLimits(body, checkedAt);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catch((error) =>
      Effect.logWarning("Cursor usage read failed.", {
        // A schema failure can echo the input it rejected, and one input is auth.json.
        cause: error._tag === "SchemaError" ? error._tag : error.message,
      }).pipe(
        Effect.as(
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message: "Cursor could not read usage limits.",
          }),
        ),
      ),
    ),
  );
});
