/**
 * The Claude driver's view of a login on a host that runs many Claude
 * accounts: a setup-token login spends a turn on the usage windows `get_usage`
 * cannot read, a slow SDK probe falls back to `claude auth status`, and a
 * login that cannot read its profile takes the account email the host named.
 *
 * @module provider/Drivers/claudeHostProbe
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/process";

import { type ClaudeAuthStatusProbe, orClaudeAuthStatus } from "../claudeColdProbe.ts";
import { type probeClaudeCapabilities, runClaudeCommand } from "../ClaudeProvider.ts";
import { makeClaudeUsageTurnReader, resolveClaudeProbeUsage } from "../claudeSetupTokenUsage.ts";
import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

export type ClaudeCapabilities = NonNullable<
  Effect.Success<ReturnType<typeof probeClaudeCapabilities>>
>;

export const makeClaudeHostProbe = Effect.fn("makeClaudeHostProbe")(function* (
  settings: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
) {
  const readUsageTurn = yield* makeClaudeUsageTurnReader;
  const services = yield* Effect.context<
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >();
  const accountEmail = settings.accountEmail || undefined;

  return {
    /** Runs after a fresh SDK probe; the result is what the capabilities cache keeps. */
    withSetupTokenUsage: (probe: ClaudeCapabilities): Effect.Effect<ClaudeCapabilities> =>
      Effect.gen(function* () {
        const claudeEnvironment = yield* makeClaudeEnvironment(settings, environment);
        const executablePath = yield* resolveClaudeSdkExecutablePath(
          settings.binaryPath,
          claudeEnvironment,
        );
        const usage = yield* resolveClaudeProbeUsage({
          usage: probe.usage,
          tokenSource: probe.tokenSource,
          turn: { executablePath, environment: claudeEnvironment, cwd },
          readUsageTurn,
        });
        const { usage: _probedUsage, ...probed } = probe;
        return usage ? { ...probed, usage } : probed;
      }).pipe(Effect.provide(services)),
    /** The capabilities the status check reads; a failed probe asks `claude auth status`. */
    readCapabilities: <E>(
      capabilities: Effect.Effect<ClaudeCapabilities, E>,
    ): Effect.Effect<ClaudeCapabilities | ClaudeAuthStatusProbe, E> =>
      capabilities.pipe(
        Effect.catch((error) =>
          orClaudeAuthStatus(runClaudeCommand(settings, ["auth", "status"], environment))(
            undefined,
          ).pipe(
            Effect.flatMap((status) =>
              status === undefined ? Effect.fail(error) : Effect.succeed(status),
            ),
          ),
        ),
        Effect.map((probe) =>
          probe.email !== undefined || accountEmail === undefined
            ? probe
            : { ...probe, email: accountEmail },
        ),
        Effect.provide(services),
      ),
  };
});
