/**
 * Keeps a Claude login usable when its CLI answers slowly, as on a host that
 * runs many Claude accounts at once. A cold CLI must not look signed out, and
 * a usage read that missed its deadline must not stick.
 *
 * @module provider/Layers/claudeColdProbe
 */
import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import { AUTH_PROBE_TIMEOUT_MS } from "@t3tools/provider-core/server/snapshotProbe";

// `get_usage` is a network round trip on the CLI the probe just spawned. The
// generic 4 s CLI budget expires after a cold init and the UI then shows
// "Could not read limits." although the account probe succeeded. This stays
// below the capabilities probe's own budget so a hang cannot discard it.
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 15_000;

export interface ClaudeCliAuthStatus {
  readonly loggedIn: boolean;
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly authMethod?: string;
  readonly apiProvider?: string;
}

function readNonEmptyJsonString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

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

/** A capabilities probe answered from `claude auth status`: no commands, no usage. */
export interface ClaudeAuthStatusProbe {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
}

/**
 * When the SDK capabilities probe returned nothing, ask `claude auth status`
 * instead, so a logged-in account still shows ready in the model picker. Its
 * usage then reads as failed, and the published windows stay until a probe
 * reads them again.
 */
export const orClaudeAuthStatus =
  <E, R>(
    readAuthStatus: Effect.Effect<{ readonly stdout: string; readonly stderr: string }, E, R>,
  ) =>
  <P>(probe: P | undefined): Effect.Effect<P | ClaudeAuthStatusProbe | undefined, never, R> =>
    probe !== undefined
      ? Effect.succeed(probe)
      : readAuthStatus.pipe(
          Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
          Effect.result,
          Effect.map((result) => {
            const output =
              Result.isSuccess(result) && Option.isSome(result.success)
                ? result.success.value
                : undefined;
            const status =
              output && parseClaudeAuthStatusOutput(`${output.stdout}\n${output.stderr}`);
            if (!status?.loggedIn) return undefined;
            return {
              email: status.email,
              subscriptionType: status.subscriptionType,
              tokenSource: status.authMethod,
              apiKeySource: undefined,
              apiProvider: status.apiProvider,
              slashCommands: [],
            } satisfies ClaudeAuthStatusProbe;
          }),
        );

/**
 * Only a fresh probe that read its usage earns the TTL. A failure, its
 * last-good fallback, or a timed-out `get_usage` retries on the next check, so
 * Settings never sticks on "Could not read limits."
 */
export const claudeProbeTimeToLive =
  (ttl: Duration.Duration) =>
  (
    exit: Exit.Exit<
      { readonly _tag: "fresh" | "fallback"; readonly capabilities: { readonly usage?: unknown } },
      unknown
    >,
  ): Duration.Duration =>
    Exit.isSuccess(exit) && exit.value._tag === "fresh" && exit.value.capabilities.usage
      ? ttl
      : Duration.zero;
