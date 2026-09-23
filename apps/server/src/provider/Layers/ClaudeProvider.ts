import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKRateLimitInfo,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import { makeUnavailableUsageLimits } from "../providerUsageLimits.ts";
import {
  type ClaudeScopedLimitNames,
  type ClaudeUsageRead,
  claudeUsageReadToLimits,
  recordClaudeUsageRead,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
} from "../ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

function readNonEmptyJsonString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export type ClaudeCliAuthStatus = {
  readonly loggedIn: boolean;
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly authMethod?: string;
  readonly apiProvider?: string;
};

/**
 * Parse `claude auth status` JSON. Email may be top-level (current CLI) or
 * nested under `account` (older fixtures). Extra log lines around the object
 * are ignored.
 */
export function parseClaudeAuthStatusOutput(output: string): ClaudeCliAuthStatus | undefined {
  const trimmed = output.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const account =
    typeof record.account === "object" && record.account !== null && !Array.isArray(record.account)
      ? (record.account as Record<string, unknown>)
      : undefined;
  const email = readNonEmptyJsonString(record.email) ?? readNonEmptyJsonString(account?.email);
  const subscriptionType = readNonEmptyJsonString(record.subscriptionType);
  const authMethod = readNonEmptyJsonString(record.authMethod);
  const apiProvider = readNonEmptyJsonString(record.apiProvider);
  return {
    loggedIn: record.loggedIn === true,
    ...(email ? { email } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(authMethod ? { authMethod } : {}),
    ...(apiProvider ? { apiProvider } : {}),
  };
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

// `get_usage` is a network round trip on the CLI we just spawned. The generic
// 4s CLI budget expires after cold init and the UI then shows "Could not read
// limits." even though the account probe succeeded. Keep this below the
// remaining process lifetime so a hang still cannot discard initialization.
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 15_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the periodic
 * health check from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the periodic Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

/**
 * The `tokenSource` a `claude setup-token` login reports. Its token carries
 * inference scope only, so `get_usage` has no windows for it.
 */
const SETUP_TOKEN_SOURCE = "CLAUDE_CODE_OAUTH_TOKEN";

export const CLAUDE_USAGE_TURN_PROMPT = "Reply with the single word OK.";

/**
 * Options for the throwaway turn that reads a setup-token account's windows:
 * the cheapest model, no tools, thinking, settings, hooks, MCP, or session.
 */
function buildClaudeUsageTurnQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    model: "haiku",
    maxTurns: 1,
    tools: [],
    thinking: { type: "disabled" },
    systemPrompt: "Reply tersely.",
    settingSources: [],
    settings: { disableAllHooks: true },
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /**
   * Subscription windows, or `undefined` when they could not be read. Absent
   * windows on a `get_usage` response mean the account has none (API key).
   */
  readonly usage?: ClaudeUsageRead;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

/** The SDK's own rejection text, not the generic wrapper `Effect.tryPromise` puts around it. */
function probeFailureMessage(error: Error): string {
  return Cause.isUnknownError(error) && error.cause instanceof Error
    ? error.cause.message
    : error.message;
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe slash commands and usage by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * The picker ready-path uses `claude auth status` instead of this spawn.
 * Overlay the result onto a ready snapshot once it lands.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
        }),
      });
      const init = await q.initializationResult();
      return { q, init, executablePath, claudeEnvironment };
    });
  }).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.flatMap(({ q, init, executablePath, claudeEnvironment }) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        const usageResult = yield* Effect.tryPromise(() =>
          q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        ).pipe(
          Effect.timeout(CLAUDE_USAGE_PROBE_TIMEOUT_MS),
          Effect.tapError((error) =>
            Effect.logWarning("Claude usage read failed.", { cause: probeFailureMessage(error) }),
          ),
          Effect.result,
        );
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        let usage: ClaudeUsageRead | undefined;
        if (Result.isSuccess(usageResult)) {
          const { rate_limits_available, rate_limits } = usageResult.success;
          if (rate_limits_available || account?.tokenSource !== SETUP_TOKEN_SOURCE) {
            usage = { source: "usageEndpoint", response: { rate_limits_available, rate_limits } };
          } else {
            abort.abort();
            const info = yield* readClaudeUsageFromTurn({
              executablePath,
              environment: claudeEnvironment,
              cwd,
            });
            usage = { source: "rateLimitEvent", info };
          }
        }
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          ...(usage ? { usage } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("Claude capabilities probe failed; usage was not read.", {
        cause: probeFailureMessage(error),
      }),
    ),
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? result.success : undefined)),
  );
};

/**
 * Read a setup-token account's windows from one throwaway turn. The
 * `rate_limit_event` arrives with the response headers, before the reply,
 * and the turn is aborted there.
 */
const readClaudeUsageFromTurn = (input: {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): Effect.Effect<SDKRateLimitInfo | undefined> => {
  const abort = new AbortController();
  return Effect.tryPromise(async () => {
    const q = claudeQuery({
      prompt: CLAUDE_USAGE_TURN_PROMPT,
      options: buildClaudeUsageTurnQueryOptions({ ...input, abortController: abort }),
    });
    for await (const message of q) {
      if (message.type === "rate_limit_event") return message.rate_limit_info;
    }
    throw new Error("The turn ended without a rate_limit_event.");
  }).pipe(
    Effect.timeout(CLAUDE_USAGE_PROBE_TIMEOUT_MS),
    Effect.ensuring(Effect.sync(() => abort.abort())),
    Effect.tapError((error) =>
      Effect.logWarning("Claude usage turn failed.", { cause: probeFailureMessage(error) }),
    ),
    Effect.orElseSucceed(() => undefined),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

const NO_SCOPED_NAMES: ClaudeScopedLimitNames = { overageIncluded: undefined };

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  /**
   * Tests and the background overlay pass this. The picker-ready path omits it
   * so `claude auth status` can mark the instance ready without an SDK spawn.
   */
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const [authProbe, skills] = yield* Effect.all(
    [
      runClaudeCommand(claudeSettings, ["auth", "status"], resolvedEnvironment).pipe(
        Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
        Effect.result,
      ),
      discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment),
    ],
    { concurrency: "unbounded" },
  );
  const cliAuth =
    Result.isSuccess(authProbe) && Option.isSome(authProbe.success)
      ? parseClaudeAuthStatusOutput(
          `${authProbe.success.value.stdout}\n${authProbe.success.value.stderr}`,
        )
      : undefined;

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const slashCommands = dedupeSlashCommands([
    COMPACT_SLASH_COMMAND,
    ...(capabilities?.slashCommands ?? []),
  ]);

  if (!capabilities && cliAuth?.loggedIn !== true) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const email = capabilities?.email ?? cliAuth?.email;
  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities?.subscriptionType ?? cliAuth?.subscriptionType,
      authMethod: capabilities?.tokenSource ?? cliAuth?.authMethod,
    }) ?? apiProviderAuthMetadata(capabilities?.apiProvider ?? cliAuth?.apiProvider);
  const usageLimits = capabilities?.usage
    ? scopedLimitNames
      ? yield* recordClaudeUsageRead(scopedLimitNames, { read: capabilities.usage, checkedAt })
      : claudeUsageReadToLimits({ read: capabilities.usage, names: NO_SCOPED_NAMES, checkedAt })
          .limits
    : undefined;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(email ? { email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      ...(usageLimits ? { usageLimits } : {}),
    },
  });
});

/**
 * Apply an SDK capabilities probe onto a snapshot that already became ready
 * from `claude auth status`. Usage that never arrived is `probeFailed`; the
 * picker does not wait on this overlay.
 */
export const overlayClaudeCapabilitiesOnSnapshot = Effect.fn("overlayClaudeCapabilitiesOnSnapshot")(
  function* (
    snapshot: ServerProvider,
    capabilities: ClaudeCapabilitiesProbe,
    scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  ): Effect.fn.Return<ServerProvider> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const previousEmail =
      snapshot.auth.status === "authenticated" ? snapshot.auth.email : undefined;
    const previousAuthMeta =
      snapshot.auth.status === "authenticated" && snapshot.auth.type
        ? { type: snapshot.auth.type, label: snapshot.auth.label }
        : undefined;
    const authMetadata =
      claudeAuthMetadata({
        subscriptionType: capabilities.subscriptionType,
        authMethod: capabilities.tokenSource,
      }) ??
      apiProviderAuthMetadata(capabilities.apiProvider) ??
      previousAuthMeta;
    const email = capabilities.email ?? previousEmail;
    const usageLimits = !capabilities.usage
      ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
      : scopedLimitNames
        ? yield* recordClaudeUsageRead(scopedLimitNames, { read: capabilities.usage, checkedAt })
        : claudeUsageReadToLimits({ read: capabilities.usage, names: NO_SCOPED_NAMES, checkedAt })
            .limits;

    return {
      ...snapshot,
      slashCommands: dedupeSlashCommands([
        COMPACT_SLASH_COMMAND,
        ...snapshot.slashCommands,
        ...capabilities.slashCommands,
      ]),
      auth: {
        status: "authenticated",
        ...(email ? { email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      status: snapshot.enabled ? "ready" : "disabled",
      usageLimits,
      checkedAt,
    };
  },
);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
