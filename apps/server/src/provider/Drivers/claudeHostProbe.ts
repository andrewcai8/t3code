/**
 * The Claude driver's view of a login on a host that runs many Claude
 * accounts: a setup-token login spends a turn on the usage windows `get_usage`
 * cannot read, a slow SDK probe falls back to `claude auth status`, and a
 * login that cannot read its profile takes the account email the host named.
 *
 * @module provider/Drivers/claudeHostProbe
 */
import type { ClaudeSettings } from "@t3tools/contracts";
import type * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { getProbeDroppingFailedUsage, orClaudeAuthStatus } from "../Layers/claudeColdProbe.ts";
import { type probeClaudeCapabilities, runClaudeCommand } from "../Layers/ClaudeProvider.ts";
import {
  makeClaudeUsageTurnReader,
  resolveClaudeProbeUsage,
} from "../Layers/claudeSetupTokenUsage.ts";
import { resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

type ClaudeCapabilities = NonNullable<Effect.Success<ReturnType<typeof probeClaudeCapabilities>>>;

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
    withSetupTokenUsage: (
      probe: ClaudeCapabilities | undefined,
    ): Effect.Effect<ClaudeCapabilities | undefined> =>
      probe === undefined
        ? Effect.succeed(undefined)
        : Effect.gen(function* () {
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
    /** The capabilities the status check reads from the probe cache. */
    readCapabilities: <K>(
      cache: Cache.Cache<K, ClaudeCapabilities | undefined>,
      key: K,
    ): Effect.Effect<ClaudeCapabilities | undefined> =>
      getProbeDroppingFailedUsage(cache, key).pipe(
        Effect.flatMap(
          orClaudeAuthStatus(runClaudeCommand(settings, ["auth", "status"], environment)),
        ),
        Effect.map((probe) =>
          probe === undefined || probe.email !== undefined || accountEmail === undefined
            ? probe
            : { ...probe, email: accountEmail },
        ),
        Effect.provide(services),
      ),
  };
});
