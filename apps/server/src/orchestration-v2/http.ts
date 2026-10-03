import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ThreadId,
  TurnItemId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import type * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { buildActiveShellSnapshot } from "./ShellStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

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

function selectHistoryPageFromCursorOrError(
  input: Parameters<typeof selectHistoryPageFromCursor>[0],
):
  | { readonly _tag: "ok"; readonly page: ReturnType<typeof selectHistoryPageFromCursor> }
  | { readonly _tag: "invalid_cursor" }
  | { readonly _tag: "error"; readonly cause: unknown } {
  try {
    return { _tag: "ok", page: selectHistoryPageFromCursor(input) };
  } catch (cause) {
    if (cause instanceof InvalidThreadHistoryCursorError) {
      return { _tag: "invalid_cursor" };
    }
    return { _tag: "error", cause };
  }
}

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket; gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const intakeContext = yield* Effect.context<
      | ThreadManagementService.ThreadManagementService
      | ThreadLaunchService.ThreadLaunchService
      | FileSystem.FileSystem
      | ServerConfig.ServerConfig
    >();

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const threads = yield* threadManagement.getShellSnapshot({ location: "active" });
          return buildActiveShellSnapshot({
            projects: yield* projectStore.listShells(),
            threads,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
          });
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      return { ...base, projects };
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    return handlers
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          );
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshotWindow(args.params.threadId);
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: bounded.projection,
            historyCursor: bounded.historyCursor,
            hasMoreHistory: bounded.hasMoreHistory,
            latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
            payloadBudgetExceeded: bounded.payloadBudgetExceeded,
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          let anchorItemId;
          try {
            anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(args.query.cursor).si);
          } catch (cause) {
            if (cause instanceof InvalidThreadHistoryCursorError) {
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            }
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          const decodedCursor = decodeThreadHistoryCursor(args.query.cursor);
          const snapshot = yield* loadThreadSnapshotWindow(
            args.params.threadId,
            anchorItemId,
            ThreadId.make(decodedCursor.st),
          );
          const pageOrError = selectHistoryPageFromCursorOrError({
            items: snapshot.projection.visibleTurnItems,
            cursor: args.query.cursor,
            snapshotSequence: snapshot.snapshotSequence,
          });
          if (pageOrError._tag === "invalid_cursor") {
            return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
          }
          if (pageOrError._tag === "error") {
            return yield* failEnvironmentInternal(
              "orchestration_thread_history_failed",
              pageOrError.cause,
            );
          }
          return {
            snapshotSequence: snapshot.snapshotSequence,
            items: pageOrError.page.items,
            nextCursor: pageOrError.page.nextCursor,
            hasMoreHistory: pageOrError.page.hasMoreHistory,
          };
        }),
      )
      .handle(
        "launchThread",
        // A host starts the chat on one of its cloud boxes here; it mirrors the WS launchThread.
        Effect.fn("environment.orchestration.launchThread")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const input = args.payload;
          const result = yield* startup
            .enqueueCommand(
              ThreadMessageIntake.launchThread({
                commandId: input.commandId,
                ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input.reuseExistingThread === undefined
                  ? {}
                  : { reuseExistingThread: input.reuseExistingThread }),
                projectId: input.projectId,
                title: input.title,
                ...(input.generateTitle === undefined
                  ? {}
                  : { generateTitle: input.generateTitle }),
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                workspaceStrategy: input.workspaceStrategy,
                ...(input.initialMessage === undefined
                  ? {}
                  : {
                      initialMessage: {
                        ...(input.initialMessage.messageId === undefined
                          ? {}
                          : { messageId: input.initialMessage.messageId }),
                        text: input.initialMessage.text,
                        attachments: input.initialMessage.attachments,
                        ...(input.initialMessage.context === undefined
                          ? {}
                          : { context: input.initialMessage.context }),
                      },
                    }),
                createdBy: "user",
                creationSource: input.creationSource ?? "server",
              }).pipe(Effect.provide(intakeContext)),
            )
            .pipe(
              Effect.catch((cause) =>
                launchRefusedForGood(cause)
                  ? failEnvironmentInvalidRequest("invalid_command")
                  : failEnvironmentInternal("orchestration_launch_thread_failed", cause),
              ),
            );
          return { threadId: result.threadId, resumed: result.resumed };
        }),
      );
  }),
);
