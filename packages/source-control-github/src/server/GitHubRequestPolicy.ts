import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubReadToken from "./GitHubReadToken.ts";

const DEFAULT_TIMEOUT = Duration.seconds(30);
/** GitHub's secondary limits penalize concurrent bursts. */
const CONCURRENCY = 8;
const REQUEST_HEADERS = { "x-github-api-version": "2022-11-28", "user-agent": "t3code" };

/** Pin requests to this host's credential across account switches. Keep it out of RPCs/cache keys. */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
  readonly source?: GitHubCredentials.GitHubCredentialSource;
} | null>("@t3tools/source-control-github/server/GitHubRequestPolicy/PinnedGitHubCredential", {
  defaultValue: () => null,
});

export class GitHubApiRequestError extends Schema.TaggedError<GitHubApiRequestError>()(
  "GitHubApiRequestError",
  { host: Schema.String, operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not reach GitHub at ${this.host}.`;
  }
}

export class GitHubApiAuthenticationError extends Schema.TaggedError<GitHubApiAuthenticationError>()(
  "GitHubApiAuthenticationError",
  { host: Schema.String, operation: Schema.String },
) {
  override get message(): string {
    return `GitHub refused the credential for ${this.host}. Run \`gh auth login --hostname ${this.host}\` and retry.`;
  }
}

export class GitHubApiRateLimitError extends Schema.TaggedError<GitHubApiRateLimitError>()(
  "GitHubApiRateLimitError",
  {
    host: Schema.String,
    operation: Schema.String,
    retryAt: Schema.optionalKey(Schema.Finite),
  },
) {
  override get message(): string {
    return "GitHub API rate limit exceeded.";
  }
}

export class GitHubApiNotFoundError extends Schema.TaggedError<GitHubApiNotFoundError>()(
  "GitHubApiNotFoundError",
  {
    host: Schema.String,
    operation: Schema.String,
    githubErrors: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The source of the credential the refused request carried, when known. */
    credential: Schema.optionalKey(GitHubCredentials.GitHubCredentialSource),
  },
) {
  override get message(): string {
    const missing =
      "GitHub could not find the requested resource, or the credential cannot see it.";
    return this.githubErrors !== undefined && this.githubErrors.length > 0
      ? `${missing} GitHub said: ${this.githubErrors.join("; ")}`
      : missing;
  }
}

export class GitHubApiResponseError extends Schema.TaggedError<GitHubApiResponseError>()(
  "GitHubApiResponseError",
  {
    host: Schema.String,
    operation: Schema.String,
    status: Schema.Int,
    githubErrors: Schema.optionalKey(Schema.Array(Schema.String)),
    githubErrorTypes: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.String))),
  },
) {
  override get message(): string {
    return this.githubErrors !== undefined && this.githubErrors.length > 0
      ? `GitHub returned an error: ${this.githubErrors.join("; ")}`
      : `GitHub returned HTTP ${this.status}.`;
  }
}

export type GitHubApiError =
  | GitHubCredentials.GitHubCredentialUnavailableError
  | GitHubAppSignIn.GitHubAppSessionError
  | GitHubApiRequestError
  | GitHubApiAuthenticationError
  | GitHubApiRateLimitError
  | GitHubApiNotFoundError
  | GitHubApiResponseError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

export function gitHubApiUrls(host: string): { readonly rest: string; readonly graphql: string } {
  const normalized = normalizeHost(host);
  if (normalized === "github.com") {
    return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  }
  if (normalized.endsWith(".ghe.com")) {
    return {
      rest: `https://api.${normalized}`,
      graphql: `https://api.${normalized}/graphql`,
    };
  }
  return { rest: `https://${normalized}/api/v3`, graphql: `https://${normalized}/api/graphql` };
}

function rateLimitAttributes(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, number | string> {
  const attributes: Record<string, number | string> = {};
  for (const [header, name] of [
    ["x-ratelimit-limit", "github.ratelimit.limit"],
    ["x-ratelimit-remaining", "github.ratelimit.remaining"],
    ["x-ratelimit-used", "github.ratelimit.used"],
    ["x-ratelimit-reset", "github.ratelimit.reset"],
  ] as const) {
    const value = Number(headers[header]);
    if (headers[header] !== undefined && Number.isFinite(value)) attributes[name] = value;
  }
  const resource = headers["x-ratelimit-resource"];
  if (resource !== undefined) attributes["github.ratelimit.resource"] = resource;
  return attributes;
}

function retryAtFrom(
  headers: Readonly<Record<string, string | undefined>>,
  now: number,
): number | undefined {
  const fromRetryAfter = SourceControlRateLimit.retryAtFromHeader(headers["retry-after"], now);
  if (fromRetryAfter !== undefined) return fromRetryAfter;
  const reset = Number(headers["x-ratelimit-reset"]) * 1_000;
  return Number.isFinite(reset) && reset > now ? reset : undefined;
}

/**
 * HTTP 200 GraphQL rate limits use RATE_LIMITED or untyped errors with quota headers. A 403 is a
 * limit only when its quota, body or GraphQL errors name one (older hosts say "abuse detection
 * mechanism"): a proxy in front of GitHub Enterprise can refuse with `Retry-After` alone.
 */
export function isRateLimited(input: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly graphqlErrors?: ReadonlyArray<{ readonly type?: unknown; readonly message?: unknown }>;
  readonly body?: string;
}): boolean {
  const { status, headers, graphqlErrors: errors } = input;
  return (
    status === 429 ||
    (errors !== undefined &&
      (headers["x-ratelimit-remaining"] === "0" ||
        errors.some(
          (error) =>
            error.type === "RATE_LIMITED" ||
            (typeof error.message === "string" &&
              /rate limit (already )?exceeded/i.test(error.message)),
        ))) ||
    (status === 403 &&
      (headers["x-ratelimit-remaining"] === "0" ||
        namesLimit(input.body) ||
        (errors ?? []).some((error) => namesLimit(error.message))))
  );
}

function namesLimit(text: unknown): boolean {
  return typeof text === "string" && /rate limit|abuse detection mechanism/i.test(text);
}

export type GitHubAnswer<A> = {
  readonly status: number | undefined;
  readonly headers: Readonly<Record<string, string | undefined>>;
} & (
  | {
      readonly _tag: "Ok";
      readonly value: A;
      /** GitHub left part of the answer out as not found or forbidden for this credential. */
      readonly withheld?: boolean;
    }
  | { readonly _tag: "RateLimited" | "Unauthorized" | "NotFound" }
  | { readonly _tag: "Failed"; readonly messages?: ReadonlyArray<string> | undefined }
);

export interface GitHubRequest {
  readonly host: string;
  readonly operation: string;
  /** The quota the request spends: `core` for REST, `graphql` for GraphQL. */
  readonly resource: string;
  readonly allowReserve: boolean;
  /** Covers sending and reading the answer. Defaults to 30 seconds. */
  readonly timeout?: Duration.Input | undefined;
  /**
   * Every reader that can see what the request names gets the same answer, so the installation
   * read token may give it in place of the user's own credential, unless one is pinned.
   */
  readonly shareable?: boolean | undefined;
}

/** REST/GraphQL share credentials, slots, quota reserves and host-wide pauses. */
export class GitHubRequestPolicy extends Context.Service<
  GitHubRequestPolicy,
  {
    /**
     * send receives auth/version headers and the source of the credential they carry; its
     * failures pass through unchanged.
     */
    readonly request: <A, E, R>(
      input: GitHubRequest,
      send: (
        headers: Readonly<Record<string, string>>,
        source: GitHubCredentials.GitHubCredentialSource | undefined,
      ) => Effect.Effect<GitHubAnswer<A>, E, R>,
    ) => Effect.Effect<A, E | GitHubApiError, R>;
    /**
     * The credential requests to `host` use: a token saved in Settings, else the app sign-in,
     * else `GH_TOKEN` or `gh`. `personal` skips the app, for repositories it cannot reach.
     */
    readonly credential: (
      host: string,
      options?: { readonly personal?: boolean },
    ) => Effect.Effect<GitHubHeldCredential, GitHubApiError>;
    /** The app sign-in's own credential, whatever else outranks it; none when not signed in. */
    readonly appCredential: (
      host: string,
    ) => Effect.Effect<Option.Option<GitHubHeldCredential>, GitHubAppSignIn.GitHubAppSessionError>;
  }
>()("@t3tools/source-control-github/server/GitHubRequestPolicy") {}

export interface GitHubHeldCredential {
  readonly source?: GitHubCredentials.GitHubCredentialSource;
  readonly token: Redacted.Redacted<string>;
  readonly fingerprint: string;
}

/**
 * A credential a request can go out with. `installation`, the read token, spends its own quota and
 * pauses, and passes on every outcome but a clean answer, failures included. `app`, the app
 * sign-in, passes an answer refused to the app on to the user's own credential. `user` settles
 * every answer.
 */
interface Rung {
  readonly kind: "installation" | "app" | "user";
  readonly held: GitHubHeldCredential;
}

/** Whether a rung passes `answer`, or a failure that left none, on to the next rung. */
function handsOn<A>(kind: Rung["kind"], answer: GitHubAnswer<A> | undefined): boolean {
  switch (kind) {
    case "installation":
      return answer?._tag !== "Ok" || answer.withheld === true;
    case "app":
      return answer !== undefined && refusedToApp(answer);
    case "user":
      return false;
  }
}

/**
 * The app reaches only repositories where it is installed. A not-found or "not accessible by
 * integration" answer to its token is worth one more try with the user's own credential.
 */
function refusedToApp<A>(answer: GitHubAnswer<A>): boolean {
  switch (answer._tag) {
    case "NotFound":
      return true;
    case "Ok":
      return answer.withheld === true;
    case "Failed":
      return (
        answer.status === 403 &&
        (answer.messages ?? []).some((message) => /not accessible by integration/i.test(message))
      );
    default:
      return false;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  const appSignIn = yield* GitHubAppSignIn.GitHubAppSignIn;
  const quota = yield* GitHubQuota.GitHubQuota;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const readToken = yield* GitHubReadToken.GitHubReadToken;
  const slots = yield* Semaphore.make(CONCURRENCY);

  const personalCredential = (host: string) =>
    credentials.get(host).pipe(
      Effect.map(({ token, fingerprint, source }): Rung => ({
        kind: "user",
        held: { token, fingerprint, source },
      })),
    );

  const appCredential: GitHubRequestPolicy["Service"]["appCredential"] = Effect.fn(
    "GitHubRest.appCredential",
  )(function* (host) {
    const token = yield* appSignIn.token(normalizeHost(host));
    if (Option.isNone(token)) return Option.none();
    return Option.some({
      source: "app" as const,
      token: Redacted.make(token.value),
      fingerprint: yield* credentials.fingerprint(normalizeHost(host), token.value),
    });
  });

  const choose = Effect.fn("GitHubRest.credential")(function* (
    host: string,
    personal: boolean,
  ): Effect.fn.Return<Rung, GitHubApiError> {
    const pinned = yield* PinnedGitHubCredential;
    if (pinned !== null) {
      if (pinned.host !== host) {
        return yield* new GitHubApiAuthenticationError({ host, operation: "credential" });
      }
      return {
        kind: "user",
        held: {
          token: pinned.token,
          fingerprint: pinned.credentialFingerprint,
          ...(pinned.source === undefined ? {} : { source: pinned.source }),
        },
      };
    }
    const saved = yield* credentials.saved(host);
    if (Option.isSome(saved)) {
      const { token, fingerprint, source } = saved.value;
      return { kind: "user", held: { token, fingerprint, source } };
    }
    if (personal) return yield* personalCredential(host);
    const app = yield* Effect.result(appCredential(host));
    // An app session that cannot refresh right now steps aside for the user's own credential.
    if (Result.isFailure(app)) {
      return yield* personalCredential(host).pipe(Effect.mapError(() => app.failure));
    }
    if (Option.isNone(app.success)) return yield* personalCredential(host);
    return { kind: "app", held: app.success.value };
  });

  const credential: GitHubRequestPolicy["Service"]["credential"] = (host, options) =>
    choose(normalizeHost(host), options?.personal === true).pipe(
      Effect.map(({ held: { token, fingerprint, source } }) => ({
        token,
        fingerprint,
        ...(source === undefined ? {} : { source }),
      })),
    );

  // The REST/GraphQL transport span owns request and quota metadata.
  const request: GitHubRequestPolicy["Service"]["request"] = Effect.fnUntraced(function* <A, E, R>(
    input: GitHubRequest,
    send: (
      headers: Readonly<Record<string, string>>,
      source: GitHubCredentials.GitHubCredentialSource | undefined,
    ) => Effect.Effect<GitHubAnswer<A>, E, R>,
  ) {
    const host = normalizeHost(input.host);
    const context = { host, operation: input.operation };
    yield* Effect.annotateCurrentSpan({
      "github.host": host,
      "github.operation": input.operation,
    });
    const scope = yield* SourceControlRateLimit.CredentialScope;
    // A refusal pauses the whole host, whichever quota it spent: the key PullRequestService
    // records its own backoff under.
    const key = { provider: SourceControlProviderKind.make("github"), host };

    /** Drops a token GitHub refused, so the next request asks its source again. */
    const drop = (rung: Rung) =>
      rung.kind === "installation"
        ? readToken.invalidate(rung.held.token)
        : // The source may hold a newer token than the one that was refused.
          appSignIn
            .invalidate(host, Redacted.value(rung.held.token))
            .pipe(Effect.andThen(credentials.invalidate(host)));

    // Settlement annotates the request span with status and rate-limit attributes.
    const settle = Effect.fnUntraced(function* (
      lease: number,
      answer: GitHubAnswer<A>,
      rung: Rung,
    ) {
      yield* quota.observe(host, answer.headers);
      yield* Effect.annotateCurrentSpan({
        ...(rung.held.source === undefined ? {} : { "github.credential": rung.held.source }),
        ...(answer.status === undefined ? {} : { "http.response.status_code": answer.status }),
        ...rateLimitAttributes(answer.headers),
      });
      switch (answer._tag) {
        case "Ok":
          yield* limits.recordSuccess({ ...key, lease });
          return answer.value;
        case "RateLimited": {
          const retryAt = retryAtFrom(answer.headers, yield* Clock.currentTimeMillis);
          yield* limits.recordRateLimit({ ...key, lease, retryAt });
          yield* Effect.annotateCurrentSpan({
            "github.rate_limited": true,
            ...(retryAt === undefined ? {} : { "github.retry_at": retryAt }),
          });
          return yield* new GitHubApiRateLimitError({
            ...context,
            ...(retryAt === undefined ? {} : { retryAt }),
          });
        }
        case "Unauthorized":
          yield* drop(rung);
          return yield* new GitHubApiAuthenticationError(context);
        case "NotFound":
          return yield* new GitHubApiNotFoundError({
            ...context,
            ...(rung.held.source === undefined ? {} : { credential: rung.held.source }),
          });
        case "Failed":
          return yield* new GitHubApiResponseError({
            ...context,
            status: answer.status ?? 200,
            ...(answer.messages === undefined ? {} : { githubErrors: answer.messages }),
          });
      }
    });

    /** Books what a rung that hands the request on spent, and why it stepped aside. */
    const passOn = Effect.fnUntraced(function* (
      rung: Rung,
      sent: Result.Result<{ readonly lease: number; readonly answer: GitHubAnswer<A> }, unknown>,
    ) {
      yield* Effect.annotateCurrentSpan({
        [`github.${rung.kind}_refused`]: Result.isSuccess(sent)
          ? sent.success.answer._tag
          : Predicate.hasProperty(sent.failure, "_tag")
            ? String(sent.failure._tag)
            : "Failed",
      });
      if (Result.isFailure(sent)) return;
      const { lease, answer } = sent.success;
      yield* quota.observe(host, answer.headers);
      switch (answer._tag) {
        case "RateLimited":
          return yield* limits.recordRateLimit({
            ...key,
            lease,
            retryAt: retryAtFrom(answer.headers, yield* Clock.currentTimeMillis),
          });
        case "Unauthorized":
          return yield* drop(rung);
        default:
          return yield* limits.recordSuccess({ ...key, lease });
      }
    });

    const chosen = yield* choose(host, false);
    // A pinned credential holds a read to one account's view, which the installation may exceed.
    const installation =
      input.shareable === true && (yield* PinnedGitHubCredential) === null
        ? yield* readToken.get(host)
        : Option.none();

    /** The rung a request that `rung` hands on goes to, if there is one. */
    const next = (rung: Rung): Effect.Effect<Option.Option<Rung>> => {
      switch (rung.kind) {
        case "installation":
          return Effect.succeedSome(chosen);
        case "app":
          return Effect.option(personalCredential(host));
        case "user":
          return Effect.succeedNone;
      }
    };

    /** One send under `rung`; `Retry` hands the request on to the next rung. */
    const attempt = (rung: Rung) =>
      slots
        .withPermit(
          Effect.gen(function* () {
            const sent = yield* Effect.result(
              quota.admit(host, input.resource, { allowReserve: input.allowReserve }).pipe(
                Effect.andThen(
                  // The user's credential stands behind a paused installation, so nothing waits on it.
                  limits.check(
                    key,
                    input.allowReserve && rung.kind !== "installation"
                      ? { allowPaused: true }
                      : undefined,
                  ),
                ),
                Effect.tapError((paused) =>
                  rung.kind === "installation"
                    ? Effect.void
                    : Effect.annotateCurrentSpan({
                        "github.paused": true,
                        "github.retry_at": paused.retryAt,
                      }),
                ),
                Effect.flatMap((lease) =>
                  // One deadline covers the headers and the body: a host that answers headers and
                  // then stalls must not hold a shared slot for undici's own five-minute body timeout.
                  send(
                    {
                      ...REQUEST_HEADERS,
                      authorization: `Bearer ${Redacted.value(rung.held.token)}`,
                    },
                    rung.held.source,
                  ).pipe(
                    Effect.timeoutOrElse({
                      duration: input.timeout ?? DEFAULT_TIMEOUT,
                      orElse: () =>
                        Effect.fail(
                          new GitHubApiRequestError({
                            ...context,
                            cause: new Cause.TimeoutError(),
                          }),
                        ),
                    }),
                    Effect.map((answer) => ({ lease, answer })),
                  ),
                ),
              ),
            );
            if (handsOn(rung.kind, Result.isSuccess(sent) ? sent.success.answer : undefined)) {
              const following = yield* next(rung);
              if (Option.isSome(following)) {
                yield* passOn(rung, sent);
                return { _tag: "Retry", with: following.value } as const;
              }
            }
            if (Result.isFailure(sent)) return yield* Effect.fail(sent.failure);
            const { lease, answer } = sent.success;
            return { _tag: "Done", value: yield* settle(lease, answer, rung) } as const;
          }),
        )
        // The rate-limit scope follows the credential, so a pause on one account never blocks
        // another. The installation keeps its own scope even where the caller names the user's.
        .pipe(
          Effect.provideService(
            SourceControlRateLimit.CredentialScope,
            rung.kind === "installation" ? rung.held.fingerprint : scope || rung.held.fingerprint,
          ),
        );

    let rung: Rung = Option.isSome(installation)
      ? {
          kind: "installation",
          // One installation's tokens share its quota, so its pauses outlast any one token.
          held: {
            source: "installation",
            token: installation.value,
            fingerprint: `${host}:installation`,
          },
        }
      : chosen;
    while (true) {
      const outcome = yield* attempt(rung);
      if (outcome._tag === "Done") return outcome.value;
      rung = outcome.with;
    }
  });

  return GitHubRequestPolicy.of({ request, credential, appCredential });
});

export const layer = Layer.effect(GitHubRequestPolicy, make);
