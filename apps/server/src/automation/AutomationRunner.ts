// @effect-diagnostics nodeBuiltinImport:off - run ids are derived with a stable hash.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ClientOrchestrationCommand,
  EnvironmentHttpApi,
  MessageId,
  ThreadId,
  defaultInstanceIdForDriver,
  type Automation,
  type EnvironmentId,
  type EnvironmentProvisionInput,
  type ProjectId,
  type ProvisionRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";

import type { EnvironmentControl } from "../environmentControl/EnvironmentControl.ts";
import type { RemoteAccess } from "../environmentControl/ProvisionedLeaseRegistry.ts";
import {
  AutomationStore,
  isInFlight,
  type RunTransition,
  type StoredRun,
} from "./AutomationStore.ts";

export interface AutomationRunnerPorts {
  readonly environmentControl: Pick<
    EnvironmentControl["Service"],
    "provision" | "attach" | "claim"
  >;
  /**
   * Disposes a failed run's machine, or finds it never existed; false when it must be retried.
   * Called only once the run's own provision call has finished or been interrupted.
   */
  readonly dispose: (run: StoredRun) => Effect.Effect<boolean>;
  /** Where the host reaches a child it provisioned, and the admin token it holds for it. */
  readonly remoteAccess: (leaseId: string) => Effect.Effect<RemoteAccess | null>;
}

/** A step that ends the run with `message` shown in its history. */
class RunFailed {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/**
 * How long a run's machine may live, from the trigger. The deadline is frozen into the provision
 * request, so it bounds the whole machine, not just its start: a working chat's box is disposed
 * at it too. The runner gives up on a start long before (see `PROVISION_TIMEOUT`); this is the
 * backstop for when disposal cannot reach the provider.
 */
const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;

/** A stable id for one thing a run creates, so a resumed run dispatches the same commands. */
export function derivedRunId(seed: string, purpose: string): string {
  const hex = NodeCrypto.createHash("sha256").update(`${seed}:${purpose}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The provision request a run drives, frozen into the run when it is triggered. A pinned account
 * is required, not just preferred.
 */
export function runProvisionInput(
  automation: Automation,
  requestId: ProvisionRequestId,
  createdAt: string,
): EnvironmentProvisionInput {
  return {
    requestId,
    provider: automation.provider,
    agentDriver: automation.agentDriver,
    providerInstanceId: automation.account ?? defaultInstanceIdForDriver(automation.agentDriver),
    ...(automation.account === null ? {} : { pinAccount: true }),
    repository: automation.repository,
    ...(automation.branch === null ? {} : { branch: automation.branch }),
    retentionDeadline: DateTime.formatIso(
      DateTime.add(DateTime.makeUnsafe(createdAt), { milliseconds: RUN_RETENTION_MS }),
    ),
  };
}

/** A start that has not reached ready by then is abandoned and its machine disposed. */
const PROVISION_TIMEOUT = Duration.minutes(30);
const PROVISION_RETRY = Duration.seconds(10);
/**
 * The longest each later step may take before the run is failed and its machine disposed, so a
 * hung call cannot hold a run in flight. Provisioning has its own limit above.
 */
const STEP_TIMEOUT = { attaching: Duration.minutes(5), starting: Duration.minutes(10) };
const PROJECT_WAIT = Duration.minutes(5);
const PROJECT_POLL = Duration.seconds(3);
/** Transient failures (a dropped request, a restarting child) get a few retries per step. */
const transient = { schedule: Schedule.exponential(Duration.seconds(2)), times: 3 };

const describe = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause);

/**
 * Drives one run from wherever it stands to `started` or `failed`.
 *
 * Every step is safe to repeat. Provision and attach are idempotent per request id, and the
 * child dedupes the two commands by their derived ids, so a host restart mid-run resumes
 * here and converges on the same machine and the same chat.
 */
export const makeAutomationRunner = Effect.fn("makeAutomationRunner")(function* (
  ports: AutomationRunnerPorts,
) {
  const store = yield* AutomationStore;
  const child = (access: RemoteAccess) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: access.origin });
  const authorization = (access: RemoteAccess) => ({
    authorization: `Bearer ${access.brokerToken}`,
  });

  /** Polls the frozen request until it is ready. */
  const provisioned = (run: StoredRun) => {
    let last = "The environment is still being prepared.";
    return Effect.gen(function* () {
      for (;;) {
        const result = yield* ports.environmentControl.provision(run.provisionInput).pipe(
          Effect.retry(transient),
          Effect.mapError((error) => new RunFailed(error.message)),
        );
        if (result.kind === "refused") return yield* Effect.fail(new RunFailed(result.message));
        if (result.kind === "ready") return;
        last = result.message;
        yield* Effect.sleep(PROVISION_RETRY);
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: PROVISION_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RunFailed(`The environment was not ready after 30 minutes. ${last}`.trim()),
          ),
      }),
    );
  };

  const attached = Effect.fnUntraced(function* (run: StoredRun) {
    const result = yield* ports.environmentControl.attach({ requestId: run.requestId }).pipe(
      Effect.retry(transient),
      Effect.mapError((error) => new RunFailed(error.message)),
    );
    if (result.kind === "refused") return yield* Effect.fail(new RunFailed(result.message));
    return result.environmentId;
  });

  const startChat = Effect.fnUntraced(function* (
    automation: Automation,
    run: StoredRun,
    environmentId: EnvironmentId,
  ) {
    const agentDriver = run.provisionInput.agentDriver ?? automation.agentDriver;
    const access = yield* ports.remoteAccess(run.requestId);
    if (!access)
      return yield* Effect.fail(new RunFailed("The host has no access to this environment."));
    const model = DEFAULT_MODEL_BY_PROVIDER[agentDriver];
    if (!model) return yield* Effect.fail(new RunFailed(`${agentDriver} has no default model.`));
    const client = yield* child(access);
    let projectId: ProjectId | undefined;
    const polls = Duration.toMillis(PROJECT_WAIT) / Duration.toMillis(PROJECT_POLL);
    for (let attempt = 0; projectId === undefined; attempt++) {
      if (attempt === polls)
        return yield* Effect.fail(
          new RunFailed("The environment's repository did not finish loading in 5 minutes."),
        );
      if (attempt > 0) yield* Effect.sleep(PROJECT_POLL);
      const shell = yield* client.orchestration
        .shellSnapshot({ headers: authorization(access) })
        .pipe(
          Effect.retry(transient),
          Effect.mapError(
            (error) => new RunFailed(`The environment did not answer: ${describe(error)}`),
          ),
        );
      projectId = shell.projects[0]?.id;
    }
    const threadId = ThreadId.make(derivedRunId(run.requestId, "thread"));
    const modelSelection = {
      instanceId: defaultInstanceIdForDriver(agentDriver),
      model,
    };
    const dispatch = (payload: ClientOrchestrationCommand) =>
      client.orchestration
        .dispatch({ headers: authorization(access), payload } as Parameters<
          typeof client.orchestration.dispatch
        >[0])
        .pipe(
          Effect.retry(transient),
          Effect.mapError(
            (error) => new RunFailed(`The chat could not be started: ${describe(error)}`),
          ),
        );
    yield* dispatch({
      type: "thread.create",
      commandId: CommandId.make(derivedRunId(run.requestId, "thread.create")),
      threadId,
      projectId,
      title: automation.name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: run.createdAt,
    });
    yield* dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(derivedRunId(run.requestId, "thread.turn.start")),
      threadId,
      message: {
        messageId: MessageId.make(derivedRunId(run.requestId, "message")),
        role: "user",
        text: run.prompt,
        attachments: [],
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: run.createdAt,
    });
    // An owned lease stays awake while its agent works; an unowned one is paused once its
    // heartbeat lapses, even mid-turn. A refused claim still leaves a working chat.
    const claimed = yield* ports.environmentControl
      .claim({ leaseId: run.requestId, environmentId, threadId })
      .pipe(Effect.orElseSucceed(() => ({ kind: "refused" as const, message: "unreachable" })));
    if (claimed.kind !== "claimed")
      yield* Effect.logWarning("automation run could not claim its lease", {
        runId: run.id,
        message: claimed.message,
      });
    return threadId;
  });

  const stepTimeout =
    (limit: Duration.Duration, what: string) =>
    <A, R>(effect: Effect.Effect<A, RunFailed, R>) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: limit,
          orElse: () =>
            Effect.fail(new RunFailed(`${what} did not finish in ${Duration.format(limit)}.`)),
        }),
      );

  /** Runs one state's work and returns the transition it earned. */
  const step = (
    automation: Automation,
    run: StoredRun,
  ): Effect.Effect<RunTransition, RunFailed, HttpClient.HttpClient> => {
    switch (run.state) {
      case "provisioning":
        return provisioned(run).pipe(Effect.as({ state: "attaching" as const }));
      case "attaching":
        return attached(run).pipe(
          stepTimeout(STEP_TIMEOUT.attaching, "Connecting to the environment"),
          Effect.map((environmentId) => ({ state: "starting" as const, environmentId })),
        );
      case "starting":
        return run.environmentId === null
          ? Effect.fail(new RunFailed("The run lost track of its environment."))
          : startChat(automation, run, run.environmentId).pipe(
              stepTimeout(STEP_TIMEOUT.starting, "Starting the chat"),
              Effect.map((threadId) => ({ state: "started" as const, threadId })),
            );
      case "started":
      case "failed":
      case "skipped":
        return Effect.die(new Error(`run ${run.id} is already ${run.state}`));
    }
  };

  return Effect.fn("AutomationRunner.run")(function* (automation: Automation, initial: StoredRun) {
    let run: StoredRun | null = initial;
    while (run !== null && isInFlight(run)) {
      const current: StoredRun = run;
      const next: RunTransition = yield* step(automation, current).pipe(
        Effect.catch((failed) =>
          Effect.gen(function* () {
            // Any failure may leave a machine, even a refusal: the manager re-checks its
            // configuration on every poll, so a refusal can follow an allocation. Disposed before
            // the run is marked failed, so a crash in between fails and disposes again. A miss is
            // retried by the service's sweep.
            const disposedAt = (yield* ports.dispose(current))
              ? DateTime.formatIso(yield* DateTime.now)
              : null;
            return { state: "failed" as const, error: failed.message, disposedAt };
          }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      // Null means the run moved on without us (deleted, or finished by another fiber).
      run = yield* store.advanceRun(current.id, current.state, next, now);
    }
    return run;
  });
});
