// @effect-diagnostics nodeBuiltinImport:off - fire ids are derived with a stable hash.
import * as NodeCrypto from "node:crypto";

import {
  cloneRepository,
  MessageId,
  ProvisionRequestId,
  ScheduledTaskError,
  ThreadId,
  type EnvironmentProvisionInput,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProvisionProvider,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { EnvironmentControl } from "../environmentControl/EnvironmentControl.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";

/**
 * How long a fire's machine may live. The deadline is frozen into the provision request, so it
 * bounds the machine even when nothing else cleans it up.
 */
const RETENTION = Duration.hours(24);
/** A machine not ready by then is abandoned and disposed. */
const PROVISION_TIMEOUT = Duration.minutes(30);
const PROVISION_RETRY = Duration.seconds(10);

/** A UUID derived from one fire, so a retried fire names the same request, chat, and message. */
function derivedFireId(fireKey: string, purpose: string): string {
  const hex = NodeCrypto.createHash("sha256").update(`${fireKey}:${purpose}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The branch the machine clones; none leaves the repository's default branch. */
function cloneBranch(strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy): string | undefined {
  return strategy.type === "worktree" ? strategy.baseRef.replace(/^origin\//, "") : strategy.branch;
}

/**
 * The provision request for one cloud fire. The account is left to routing, which runs the chat
 * on the model's driver account with the most usage left. The host starts the first turn itself.
 */
export function cloudFireInput(input: {
  readonly task: ScheduledTask;
  readonly provider: ProvisionProvider;
  readonly fireKey: string;
  readonly firedAt: DateTime.Utc;
  readonly repository: string | undefined;
}): EnvironmentProvisionInput {
  const { task, fireKey, repository } = input;
  const branch = cloneBranch(task.workspaceStrategy);
  return {
    requestId: ProvisionRequestId.make(derivedFireId(fireKey, "request")),
    retentionDeadline: DateTime.formatIso(DateTime.addDuration(input.firedAt, RETENTION)),
    provider: input.provider,
    providerInstanceId: task.modelSelection.instanceId,
    ...(repository === undefined ? {} : { repository, ...(branch ? { branch } : {}) }),
    chat: {
      threadId: ThreadId.make(derivedFireId(fireKey, "thread")),
      firstTurn: {
        messageId: MessageId.make(derivedFireId(fireKey, "message")),
        text: task.prompt,
        title: task.title,
        modelSelection: task.modelSelection,
        runtimeMode: task.runtimeMode,
        interactionMode: task.interactionMode,
        createdAt: DateTime.formatIso(input.firedAt),
      },
    },
  };
}

const failed = (task: ScheduledTask, message: string) =>
  new ScheduledTaskError({ message, taskId: task.id });

/**
 * Starts one fire of a task on a fresh cloud machine, succeeding once the machine is ready and
 * holds the chat's first turn. Without a host that can provision, every cloud fire fails.
 */
export class ScheduledCloudFire extends Context.Reference<{
  readonly fire: (input: {
    readonly task: ScheduledTask;
    readonly provider: ProvisionProvider;
    readonly fireKey: string;
  }) => Effect.Effect<void, ScheduledTaskError>;
}>("t3/scheduledTasks/ScheduledCloudFire", {
  defaultValue: () => ({
    fire: ({ task }) => Effect.fail(failed(task, "This server cannot start cloud machines.")),
  }),
}) {}

export const layer = Layer.effect(
  ScheduledCloudFire,
  Effect.gen(function* () {
    const control = yield* EnvironmentControl;
    const projects = yield* ProjectService.ProjectService;
    const repositories = yield* RepositoryIdentityResolver;

    const untilReady = (task: ScheduledTask, request: EnvironmentProvisionInput) =>
      Effect.gen(function* () {
        for (;;) {
          const result = yield* control
            .provision(request)
            .pipe(Effect.mapError((error) => failed(task, error.message)));
          if (result.kind === "refused") return yield* failed(task, result.message);
          if (result.kind === "ready") {
            if (result.environment.firstTurn === "failed")
              return yield* failed(task, "The machine started but did not take the first turn.");
            return;
          }
          yield* Effect.sleep(PROVISION_RETRY);
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: PROVISION_TIMEOUT,
          orElse: () => Effect.fail(failed(task, "The machine was not ready after 30 minutes.")),
        }),
      );

    return ScheduledCloudFire.of({
      fire: Effect.fn("ScheduledCloudFire.fire")(function* ({ task, provider, fireKey }) {
        const project = yield* projects
          .getById(task.projectId)
          .pipe(Effect.mapError((cause) => failed(task, cause.message)));
        if (Option.isNone(project)) return yield* failed(task, "The task's project is gone.");
        // Resolved here rather than read off the project, whose identity stays empty until a
        // background lookup lands, as on the first fire after a restart.
        const identity = yield* repositories.resolve(project.value.workspaceRoot);
        const request = cloudFireInput({
          task,
          provider,
          fireKey,
          firedAt: yield* DateTime.now,
          repository: cloneRepository(identity),
        });
        // A refusal can follow an allocation, so any failure may leave a machine behind.
        yield* untilReady(task, request).pipe(
          Effect.tapError(() =>
            control.dispose({ requestId: request.requestId }).pipe(Effect.ignore),
          ),
        );
      }),
    });
  }),
);
