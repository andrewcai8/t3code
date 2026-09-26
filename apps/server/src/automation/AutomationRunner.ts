// @effect-diagnostics nodeBuiltinImport:off - run ids are derived with a stable hash.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentHttpApi,
  MessageId,
  ThreadId,
  defaultInstanceIdForDriver,
  type Automation,
  type EnvironmentId,
  type EnvironmentProvisionInput,
  type ProjectId,
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
import { AutomationStore, type RunTransition, type StoredRun } from "./AutomationStore.ts";

export interface AutomationRunnerPorts {
  readonly environmentControl: Pick<
    EnvironmentControl["Service"],
    "provision" | "attach" | "claim"
  >;
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

/** A stable id for one thing a run creates, so a resumed run dispatches the same commands. */
export function derivedRunId(seed: string, purpose: string): string {
  const hex = NodeCrypto.createHash("sha256").update(`${seed}:${purpose}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The provision request a run drives. A pinned account is required, not just preferred. */
function runProvisionInput(
  run: Pick<StoredRun, "requestId">,
  automation: Automation,
): EnvironmentProvisionInput {
  return {
    requestId: run.requestId,
    provider: automation.provider,
    agentDriver: automation.agentDriver,
    providerInstanceId: automation.account ?? defaultInstanceIdForDriver(automation.agentDriver),
    ...(automation.account === null ? {} : { pinAccount: true }),
    repository: automation.repository,
    ...(automation.branch === null ? {} : { branch: automation.branch }),
  };
}

const PROVISION_ATTEMPTS = 30;
const PROVISION_RETRY = Duration.seconds(10);
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

  const provisioned = Effect.fnUntraced(function* (automation: Automation, run: StoredRun) {
    const input = runProvisionInput(run, automation);
    let last = "The environment is still being prepared.";
    for (let attempt = 0; attempt < PROVISION_ATTEMPTS; attempt++) {
      const result = yield* ports.environmentControl.provision(input).pipe(
        Effect.retry(transient),
        Effect.mapError((error) => new RunFailed(error.message)),
      );
      if (result.kind === "ready") return;
      if (result.kind === "refused") return yield* Effect.fail(new RunFailed(result.message));
      last = result.message;
      yield* Effect.sleep(PROVISION_RETRY);
    }
    return yield* Effect.fail(new RunFailed(last));
  });

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
    const access = yield* ports.remoteAccess(run.requestId);
    if (!access)
      return yield* Effect.fail(new RunFailed("The host has no access to this environment."));
    const model = DEFAULT_MODEL_BY_PROVIDER[automation.agentDriver];
    if (!model)
      return yield* Effect.fail(new RunFailed(`${automation.agentDriver} has no default model.`));
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
      instanceId: defaultInstanceIdForDriver(automation.agentDriver),
      model,
    };
    const dispatch = (payload: Parameters<typeof client.orchestration.dispatch>[0]["payload"]) =>
      client.orchestration.dispatch({ headers: authorization(access), payload }).pipe(
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

  /** Runs one state's work and returns the transition it earned. */
  const step = (
    automation: Automation,
    run: StoredRun,
  ): Effect.Effect<RunTransition, RunFailed, HttpClient.HttpClient> => {
    switch (run.state) {
      case "provisioning":
        return provisioned(automation, run).pipe(Effect.as({ state: "attaching" as const }));
      case "attaching":
        return attached(run).pipe(
          Effect.map((environmentId) => ({ state: "starting" as const, environmentId })),
        );
      case "starting":
        return run.environmentId === null
          ? Effect.fail(new RunFailed("The run lost track of its environment."))
          : startChat(automation, run, run.environmentId).pipe(
              Effect.map((threadId) => ({ state: "started" as const, threadId })),
            );
      case "started":
      case "failed":
        return Effect.die(new Error(`run ${run.id} is already ${run.state}`));
    }
  };

  return Effect.fn("AutomationRunner.run")(function* (automation: Automation, initial: StoredRun) {
    let run: StoredRun | null = initial;
    while (run !== null && run.state !== "started" && run.state !== "failed") {
      const current: StoredRun = run;
      const next = yield* step(automation, current).pipe(
        Effect.catch((failed) =>
          Effect.succeed({ state: "failed" as const, error: failed.message }),
        ),
      );
      const now = DateTime.formatIso(yield* DateTime.now);
      // Null means the run moved on without us (deleted, or finished by another fiber).
      run = yield* store.advanceRun(current.id, current.state, next, now);
    }
    return run;
  });
});
