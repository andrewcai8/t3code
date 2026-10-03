/**
 * A host starts the chat on one of its cloud boxes through the box's
 * `launchThread` HTTP endpoint. It mirrors the WS `launchThread` handler.
 *
 * @module orchestration-v2/hostLaunchThread
 */
import {
  AuthOrchestrationOperateScope,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  type OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

import {
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type * as ServerConfig from "../config.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import type * as ThreadLaunchService from "./ThreadLaunchService.ts";
import type * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";

const refusedForGoodTags: ReadonlySet<string> = new Set([
  "AttachmentClaimError",
  "OrchestratorCommandRejectedError",
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorCommandIdConflictError",
]);

/**
 * A launch the box will never accept, whatever the retry: the caller gets a 4xx and stops. Any
 * other failure is a 5xx it retries under the same command id.
 */
export function launchRefusedForGood(error: unknown): boolean {
  if (!Predicate.hasProperty(error, "_tag")) return false;
  if (typeof error._tag === "string" && refusedForGoodTags.has(error._tag)) return true;
  return (
    error._tag === "ThreadLaunchError" &&
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    typeof error.cause._tag === "string" &&
    refusedForGoodTags.has(error.cause._tag)
  );
}

/** Drops a decoded value's `undefined` optional keys, as `exactOptionalPropertyTypes` wants. */
type WithoutUndefined<T> = { [K in keyof T]: Exclude<T[K], undefined> };
const withoutUndefined = <T extends object>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as WithoutUndefined<T>;

/** The launch a client asked for, every decoded field kept; `creationSource` defaults to server. */
const clientLaunchInput = ({
  initialMessage,
  ...input
}: OrchestrationV2ThreadLaunchInput): ThreadLaunchService.ThreadLaunchInput => ({
  ...withoutUndefined(input),
  ...(initialMessage === undefined ? {} : { initialMessage: withoutUndefined(initialMessage) }),
  createdBy: "user",
  creationSource: input.creationSource ?? "server",
});

/** The `launchThread` endpoint's handler body, built once with the layer's services. */
export const makeHostLaunchThread = Effect.gen(function* () {
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const intakeContext = yield* Effect.context<
    | ThreadManagementService.ThreadManagementService
    | ThreadLaunchService.ThreadLaunchService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
  >();
  return Effect.fn("environment.orchestration.launchThread")(function* (
    payload: OrchestrationV2ThreadLaunchInput,
  ) {
    yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
    const result = yield* startup
      .enqueueCommand(
        ThreadMessageIntake.launchThread(clientLaunchInput(payload)).pipe(
          Effect.provide(intakeContext),
        ),
      )
      .pipe(
        Effect.catch(
          (
            cause,
          ): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentInternalError> =>
            launchRefusedForGood(cause)
              ? failEnvironmentInvalidRequest("invalid_command")
              : failEnvironmentInternal("internal_error", cause),
        ),
      );
    return { threadId: result.threadId, resumed: result.resumed };
  });
});
