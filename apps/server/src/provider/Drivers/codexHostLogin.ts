/**
 * The Codex driver's view of the login in an instance's `auth.json`: when a
 * status probe should ask Codex to refresh it, when a login Codex still calls
 * signed in is dead, and, on a cloud-only host, an hourly refresh that does
 * not wait for a client to trigger a probe.
 *
 * @module provider/Drivers/codexHostLogin
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import {
  CODEX_LOGIN_REFRESH_AHEAD_MS,
  codexLoginExpiredMessage,
  codexLoginRefreshDue,
  codexLoginSignedOut,
  parseCodexLogin,
} from "../codexLoginCopy.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

export const makeCodexHostLogin = Effect.fn("makeCodexHostLogin")(function* (input: {
  readonly authPath: string;
  readonly instanceName: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const { localAgentRuns } = yield* ServerConfig.ServerConfig;
  const readLoginAt = Effect.zipWith(
    fileSystem.readFileString(input.authPath).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.map(parseCodexLogin),
    ),
    Clock.currentTimeMillis,
    (login, now) => ({ login, context: { now, localAgentRuns } }),
  );
  const refreshDue = readLoginAt.pipe(
    Effect.map(({ login, context }) =>
      codexLoginRefreshDue(login, CODEX_LOGIN_REFRESH_AHEAD_MS, context),
    ),
  );
  // Codex still reports a copied login (`stripCodexRefreshToken`) as signed
  // in after its access token dies, and no refresh will ever revive it. The
  // same goes for a host's own login whose refresh failed.
  const markSignedOutLogin = (draft: ServerProviderDraft) =>
    draft.auth.status !== "authenticated"
      ? Effect.succeed(draft)
      : readLoginAt.pipe(
          Effect.map(({ login, context }): ServerProviderDraft =>
            codexLoginSignedOut(login, context)
              ? {
                  ...draft,
                  status: "error",
                  auth: { status: "unauthenticated" },
                  message: codexLoginExpiredMessage(input.instanceName, login, context),
                }
              : draft,
          ),
        );

  return {
    /** Runs a status probe, refreshing the login when due, and marks a dead login signed out. */
    checkStatus: <E, R>(
      probe: (refreshLogin: boolean) => Effect.Effect<ServerProviderDraft, E, R>,
    ) => refreshDue.pipe(Effect.flatMap(probe), Effect.flatMap(markSignedOutLogin)),
    /**
     * On a host, the status probe refreshes the host's own login once it is
     * due, but probes run on an interval only while a client is watching, and
     * a host mostly runs unwatched. Probes for one instance never overlap, so
     * this cannot race the usage probe.
     */
    keepRefreshed: (refresh: Effect.Effect<unknown>): Effect.Effect<void, never, Scope.Scope> =>
      localAgentRuns
        ? Effect.void
        : Effect.sleep("1 hour").pipe(
            Effect.andThen(refreshDue),
            Effect.flatMap((due) =>
              due ? refresh.pipe(Effect.andThen(refreshDue)) : Effect.succeed(false),
            ),
            Effect.flatMap((stillDue) =>
              stillDue ? Effect.logWarning("Codex did not refresh this login.") : Effect.void,
            ),
            Effect.ignoreCause({ log: true }),
            Effect.forever,
            Effect.annotateLogs({ providerInstance: input.instanceName }),
            Effect.forkScoped,
            Effect.asVoid,
          ),
  };
});
