/**
 * Usage windows for `claude setup-token` logins, the accounts cloud hosts run
 * chats on. Their token carries inference scope only, so `get_usage` reports
 * no windows. A turn's `rate_limit_event` carries them instead, every window
 * under the untyped `unifiedWindows` with no top-level utilization, so the
 * capabilities probe spends one throwaway turn to read them.
 *
 * @module provider/Layers/claudeSetupTokenUsage
 */
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SDKControlGetUsageResponse,
  type SDKRateLimitInfo,
} from "@anthropic-ai/claude-agent-sdk";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/** The `tokenSource` a `claude setup-token` login reports. */
const SETUP_TOKEN_SOURCE = "CLAUDE_CODE_OAUTH_TOKEN";

export const CLAUDE_USAGE_TURN_PROMPT = "Reply with the single word OK.";

const CLAUDE_USAGE_TURN_TIMEOUT_MS = 15_000;

/**
 * How often a setup-token account spends a turn on reading its windows.
 * Routing trusts usage for 30 minutes, and real turns report in between.
 * Every turn opens the five-hour window, so a shorter cadence would keep an
 * idle account's session window open for good.
 */
const CLAUDE_USAGE_TURN_TTL = Duration.minutes(30);

type ClaudeUsageResponse = Pick<
  SDKControlGetUsageResponse,
  "rate_limits_available" | "rate_limits"
>;

/**
 * `unifiedWindows` is marked internal in the CLI and missing from the SDK
 * typings, so it is parsed rather than trusted.
 */
const UnifiedWindow = Schema.Struct({ utilization: Schema.Finite, resetsAt: Schema.Finite });
const decodeUnifiedWindows = Schema.decodeUnknownOption(
  Schema.Struct({
    five_hour: Schema.optional(UnifiedWindow),
    seven_day: Schema.optional(UnifiedWindow),
    seven_day_overage_included: Schema.optional(UnifiedWindow),
  }),
);

/**
 * The event split into one single-window event per entry of
 * `unifiedWindows`, or undefined when it carries none.
 */
export function unifiedWindowEvents(info: SDKRateLimitInfo): SDKRateLimitInfo[] | undefined {
  const unified = decodeUnifiedWindows(
    (info as { readonly unifiedWindows?: unknown }).unifiedWindows,
  );
  if (Option.isNone(unified)) return undefined;
  const events = Object.entries(unified.value).flatMap(([type, window]) =>
    window
      ? [
          {
            status: info.status,
            rateLimitType: type as NonNullable<SDKRateLimitInfo["rateLimitType"]>,
            utilization: window.utilization,
            resetsAt: window.resetsAt,
          } satisfies SDKRateLimitInfo,
        ]
      : [],
  );
  return events.length > 0 ? events : undefined;
}

const isoFromEpochSeconds = (seconds: number | undefined) =>
  seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000))
    : null;

/**
 * A turn's event as the `get_usage` response the capabilities probe reads,
 * or undefined when it reports no account-wide window.
 */
export function rateLimitEventToUsageResponse(
  info: SDKRateLimitInfo,
): ClaudeUsageResponse | undefined {
  const rateLimits: NonNullable<ClaudeUsageResponse["rate_limits"]> = {};
  for (const event of unifiedWindowEvents(info) ?? [info]) {
    const type = event.rateLimitType;
    if ((type !== "five_hour" && type !== "seven_day") || typeof event.utilization !== "number") {
      continue;
    }
    rateLimits[type] = {
      utilization: event.utilization * 100,
      resets_at: isoFromEpochSeconds(event.resetsAt),
    };
  }
  return Object.keys(rateLimits).length > 0
    ? { rate_limits_available: true, rate_limits: rateLimits }
    : undefined;
}

export interface ClaudeUsageTurnInput {
  readonly executablePath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}

/** Undefined when the turn failed or one ran within the TTL. */
export type ClaudeUsageTurnReader = (
  input: ClaudeUsageTurnInput,
) => Effect.Effect<ClaudeUsageResponse | undefined>;

/**
 * The cheapest model, no tools, thinking, settings, hooks, MCP, or session.
 */
function buildClaudeUsageTurnQueryOptions(
  input: ClaudeUsageTurnInput & { readonly abortController: AbortController },
): ClaudeQueryOptions {
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

/**
 * The `rate_limit_event` arrives with the response headers, before the
 * reply, and the turn is aborted there.
 */
const readFreshClaudeUsageTurn: ClaudeUsageTurnReader = (input) => {
  const abort = new AbortController();
  return Effect.tryPromise(async () => {
    const q = claudeQuery({
      prompt: CLAUDE_USAGE_TURN_PROMPT,
      options: buildClaudeUsageTurnQueryOptions({ ...input, abortController: abort }),
    });
    for await (const message of q) {
      if (message.type === "rate_limit_event") {
        return rateLimitEventToUsageResponse(message.rate_limit_info);
      }
    }
    return undefined;
  }).pipe(
    Effect.timeout(CLAUDE_USAGE_TURN_TIMEOUT_MS),
    Effect.ensuring(Effect.sync(() => abort.abort())),
    Effect.orElseSucceed(() => undefined),
  );
};

/** One per instance: at most one usage turn per TTL, failed turns included. */
export const makeClaudeUsageTurnReader = Effect.gen(function* () {
  const lastTurnAt = yield* Ref.make<number | undefined>(undefined);
  const reader: ClaudeUsageTurnReader = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(lastTurnAt);
      if (last !== undefined && now - last < Duration.toMillis(CLAUDE_USAGE_TURN_TTL)) {
        return undefined;
      }
      yield* Ref.set(lastTurnAt, now);
      return yield* readFreshClaudeUsageTurn(input);
    });
  return reader;
});

/**
 * The capabilities probe's usage: `get_usage` for any login it answers, a
 * usage turn for a setup-token login it cannot. An undefined result reads
 * as a failed probe, which keeps the windows already published.
 */
export const resolveClaudeProbeUsage = (input: {
  readonly usage: ClaudeUsageResponse | undefined;
  readonly tokenSource: string | undefined;
  readonly turn: ClaudeUsageTurnInput;
  readonly readUsageTurn: ClaudeUsageTurnReader | undefined;
}): Effect.Effect<ClaudeUsageResponse | undefined> =>
  input.usage && !input.usage.rate_limits_available && input.tokenSource === SETUP_TOKEN_SOURCE
    ? (input.readUsageTurn ?? readFreshClaudeUsageTurn)(input.turn)
    : Effect.succeed(input.usage);
