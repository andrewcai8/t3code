import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/**
 * An executable, run with no shell and no arguments, that prints a GitHub App installation token
 * for github.com and exits 0, or exits non-zero when it has none. Reads whose answer is the same
 * for any reader then spend the installation's quota rather than the user's. Unset, every
 * request carries the user's own credential.
 */
export const COMMAND_VARIABLE = "T3CODE_GITHUB_READ_TOKEN_COMMAND";

const HOST = "github.com";
const TOKEN_TTL = Duration.minutes(5);
// A broken command is not run again for every request.
const FAILURE_TTL = Duration.seconds(30);

export const GitHubReadToken = Context.Reference<{
  /** The installation token for `host`; none when unset, when the command fails, or off github.com. */
  readonly get: (host: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  /** Runs the command again on the next `get`, and never hands out `rejected` again. */
  readonly invalidate: (rejected: Redacted.Redacted<string>) => Effect.Effect<void>;
}>("@t3tools/source-control-github/server/GitHubReadToken", {
  defaultValue: () => ({ get: () => Effect.succeedNone, invalidate: () => Effect.void }),
});

/** @public */
export const make = Effect.gen(function* () {
  const command = (yield* HostProcess.Environment)[COMMAND_VARIABLE]?.trim() ?? "";
  if (command === "") return GitHubReadToken.defaultValue();
  const process = (yield* SourceControlHost.SourceControlHost).process;
  const cwd = yield* HostProcess.WorkingDirectory;
  let refused: string | undefined;

  const cache = yield* Cache.makeWith(
    () =>
      process
        .run({
          operation: "GitHubReadToken.get",
          command,
          args: [],
          cwd,
          env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" },
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.map((output) => output.stdout.trim()),
          // A command that keeps printing a token GitHub refused waits out FAILURE_TTL.
          Effect.filterOrFail(
            (token) => /^\S+$/.test(token) && token !== refused,
            () => "no usable token",
          ),
          Effect.map(Redacted.make),
        ),
    {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? TOKEN_TTL : FAILURE_TTL),
    },
  );

  return {
    get: (host: string) =>
      normalizeHost(host) === HOST ? Effect.option(Cache.get(cache, HOST)) : Effect.succeedNone,
    invalidate: (rejected: Redacted.Redacted<string>) =>
      Effect.suspend(() => {
        refused = Redacted.value(rejected);
        return Cache.invalidate(cache, HOST);
      }),
  };
});

export const layer = Layer.effect(GitHubReadToken, make);
