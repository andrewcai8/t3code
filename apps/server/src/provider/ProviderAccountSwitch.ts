/**
 * Moves one of this server's provider instances onto another account while it runs, for the host
 * that provisioned this machine. The new login takes effect without a restart: the instance is
 * rebuilt from settings, and the moving chat's live provider session is released so its next turn
 * starts a fresh CLI process that resumes the same native session.
 *
 * Only the moving chat's session restarts. Other chats on the instance keep their running process
 * on the old login until it next releases.
 *
 * @module provider/ProviderAccountSwitch
 */
import {
  ClaudeSettings,
  CodexSettings,
  CommandId,
  defaultInstanceIdForDriver,
  type GuestAccountSwitchInput,
  type GuestAccountSwitchResult,
  MessageId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { credentialVariables } from "../environmentControl/ProvisioningProviderProfile.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

export class ProviderAccountSwitchError extends Schema.TaggedError<ProviderAccountSwitchError>()(
  "ProviderAccountSwitchError",
  {
    stage: Schema.Literals(["read-thread", "write-login", "update-settings", "release"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The provider account could not be switched.";
  }
}

/** A run in one of these states has a live turn that releasing its session would cut. */
const RUN_IN_FLIGHT: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** How long a switch waits for the provider instance to be rebuilt on its new login. */
const RELOAD_TIMEOUT = "30 seconds";

export class ProviderAccountSwitch extends Context.Service<
  ProviderAccountSwitch,
  {
    readonly switchAccount: (
      input: GuestAccountSwitchInput,
    ) => Effect.Effect<GuestAccountSwitchResult, ProviderAccountSwitchError>;
  }
>()("t3/provider/ProviderAccountSwitch") {}

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsModule.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const switching = yield* Semaphore.make(1);

  /** The login file the driver's CLI reads before any credential variable. */
  const loginFilePath = Effect.fnUntraced(function* (instance: ProviderInstanceConfig) {
    if (instance.driver === "codex") {
      const layout = yield* resolveCodexHomeLayout(
        yield* decodeCodexSettings(instance.config ?? {}),
      );
      return path.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json");
    }
    const config = yield* decodeClaudeSettings(instance.config ?? {});
    const configDir = yield* resolveClaudeHomePath(
      config,
      mergeProviderInstanceEnvironment(instance.environment ?? []),
    );
    return path.join(configDir, ".credentials.json");
  });

  const writeLoginFile = Effect.fnUntraced(function* (filePath: string, contents: Uint8Array) {
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.switching`;
    yield* fs.writeFile(temporary, contents, { mode: 0o600 });
    yield* fs.rename(temporary, filePath);
  });

  /** The instance as it reads with the new account's login in place of the old one's. */
  const withAccount = (
    current: ProviderInstanceConfig,
    input: GuestAccountSwitchInput,
  ): ProviderInstanceConfig => {
    const names = credentialVariables[input.driver];
    const environment: ProviderInstanceEnvironmentVariable[] = [
      ...(current.environment ?? []).filter((variable) => !names.includes(variable.name)),
      ...(input.credential.kind === "environment"
        ? input.credential.variables.map(({ name, value }) => ({ name, value, sensitive: true }))
        : []),
    ];
    const { displayName: _previousName, ...rest } = current;
    // A Claude setup token cannot name its account, so the email travels with it.
    const config =
      input.driver === "claudeAgent"
        ? withAccountEmail(current.config, input.accountEmail)
        : current.config;
    return {
      ...rest,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(config === undefined ? {} : { config }),
      environment,
    };
  };

  /**
   * Waits until the registry holds a rebuilt instance. A settings change reaches the registry on
   * its own fiber, and a turn started before that would open on the old login. An instance that
   * never rebuilds, such as one whose config no longer decodes, is not waited on past the timeout.
   */
  const awaitRebuilt = (instanceId: ProviderInstanceId, previous: ProviderInstance) =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* instances.subscribeChanges;
        while ((yield* instances.getInstance(instanceId)) === previous) {
          yield* PubSub.take(changes);
        }
      }),
    ).pipe(
      Effect.timeoutOption(RELOAD_TIMEOUT),
      Effect.flatMap((rebuilt) =>
        Option.isSome(rebuilt)
          ? Effect.void
          : Effect.logWarning("provider instance was not rebuilt after an account switch", {
              instanceId,
            }),
      ),
    );

  const switchAccount = Effect.fn("ProviderAccountSwitch.switchAccount")(function* (
    input: GuestAccountSwitchInput,
  ) {
    const instanceId = defaultInstanceIdForDriver(ProviderDriverKind.make(input.driver));
    const records = yield* threads
      .getThreadRecords(input.threadId, ["runs", "providerSessions"])
      .pipe(
        Effect.mapError((cause) => new ProviderAccountSwitchError({ stage: "read-thread", cause })),
      );
    if (records.runs.some((run) => RUN_IN_FLIGHT.has(run.status)))
      return {
        kind: "refused",
        reason: "busy",
        message: "This chat is working. Switch accounts once its turn ends.",
      } satisfies GuestAccountSwitchResult;
    const before = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new ProviderAccountSwitchError({ stage: "update-settings", cause }),
      ),
    );
    const current = before.providerInstances[instanceId];
    const names = credentialVariables[input.driver];
    if (
      current === undefined ||
      current.driver !== input.driver ||
      (input.credential.kind === "environment" &&
        input.credential.variables.some(({ name }) => !names.includes(name)))
    )
      return {
        kind: "refused",
        reason: "unsupported",
        message: "This machine has no account of that provider to switch.",
      } satisfies GuestAccountSwitchResult;
    const loginFile = yield* loginFilePath(current).pipe(
      Effect.mapError((cause) => new ProviderAccountSwitchError({ stage: "write-login", cause })),
    );
    // A login file wins over credential variables, so a file login lands before settings name the
    // account, and a variable login only removes the file once settings carry the variable.
    if (input.credential.kind === "file")
      yield* writeLoginFile(loginFile, Buffer.from(input.credential.contentsBase64, "base64")).pipe(
        Effect.mapError((cause) => new ProviderAccountSwitchError({ stage: "write-login", cause })),
      );
    const previous = yield* instances.getInstance(instanceId);
    const after = yield* settings
      .updateProviderInstance({
        operation: "upsert",
        instanceId,
        instance: withAccount(current, input),
      })
      .pipe(
        Effect.mapError(
          (cause) => new ProviderAccountSwitchError({ stage: "update-settings", cause }),
        ),
      );
    if (input.credential.kind === "environment")
      yield* fs
        .remove(loginFile, { force: true })
        .pipe(
          Effect.mapError(
            (cause) => new ProviderAccountSwitchError({ stage: "write-login", cause }),
          ),
        );
    if (previous !== undefined && !sameInstance(before, after, instanceId))
      yield* awaitRebuilt(instanceId, previous);
    yield* Effect.forEach(
      records.providerSessions.filter(
        (session) =>
          session.providerInstanceId === instanceId &&
          session.status !== "stopped" &&
          session.status !== "error",
      ),
      (session) =>
        sessions.release({
          providerSessionId: session.id,
          reason: "manual_shutdown",
          detail: "Provider account switched.",
        }),
      { discard: true },
    ).pipe(Effect.mapError((cause) => new ProviderAccountSwitchError({ stage: "release", cause })));
    if (input.continueRunId === undefined)
      return { kind: "switched", continued: false } satisfies GuestAccountSwitchResult;
    // Keyed by the run, so a retried switch continues it once.
    const continuation = `account-switch:${input.continueRunId}`;
    const continued = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(continuation),
        messageId: MessageId.make(continuation),
        threadId: input.threadId,
        manualContinuationOfRunId: input.continueRunId,
        text: "Continue where you left off.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.as(true),
        // The account already moved. A run that can no longer be continued leaves the chat for
        // its user to resume.
        Effect.catch((cause) =>
          Effect.logWarning("provider account switched without continuing its run", {
            threadId: input.threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    return { kind: "switched", continued } satisfies GuestAccountSwitchResult;
  });

  return ProviderAccountSwitch.of({
    switchAccount: (input) => switching.withPermits(1)(switchAccount(input)),
  });
});

/** A Claude instance's config naming the new account's email, or none when it has no email. */
const withAccountEmail = (config: unknown, accountEmail: string | undefined) => {
  const { accountEmail: _previous, ...rest } = Predicate.isObject(config)
    ? (config as Record<string, unknown>)
    : {};
  return accountEmail ? { ...rest, accountEmail } : rest;
};

/** Whether a settings write left the instance as the registry builds it unchanged. */
const sameInstance = (
  before: ServerSettings,
  after: ServerSettings,
  instanceId: ProviderInstanceId,
) =>
  Equal.equals(
    deriveProviderInstanceConfigMap(before)[instanceId],
    deriveProviderInstanceConfigMap(after)[instanceId],
  );

export const layer = Layer.effect(ProviderAccountSwitch, make);
