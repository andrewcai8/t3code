/**
 * End-to-end smoke for cloud chats against a live T3 manager: provision one box, run one turn
 * per agent in it, pause and resume it, then delete it. Every check lands in a JSON report and
 * the process exits nonzero when any check fails.
 *
 *   node scripts/cloud/smoke-cloud-chat.ts --origin https://host --pairing-token-file ./token \
 *     --provider e2b --agents codex,claudeAgent,cursor --report ./run.json
 *
 * `--steps automation` instead proves automations: it creates one with a webhook, calls the link,
 * waits for the run's chat on its own box, reads the agent's reply, then deletes the automation
 * and disposes the box.
 *
 * The pairing token is exchanged once; the bearer is cached next to it (0600) until it expires.
 * Tokens, pairing URLs and webhook links never reach stdout or the report.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  AUTOMATION_WEBHOOK_PATH_PREFIX,
  type AutomationId,
  CommandId,
  MessageId,
  type OrchestrationThreadStreamItem,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProvisionRequestId,
  type ProvisionedEnvironment,
  type ServerProvider,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

/** Where each driver loads user skills from, relative to the box's HOME. */
const SKILL_ROOT = {
  codex: ".codex/skills",
  claudeAgent: ".claude/skills",
  cursor: ".cursor/skills",
};
/**
 * Each driver's pstack per-role model sheet: HOME-relative for Claude and Codex, and
 * checkout-relative for Cursor, whose CLI reads rules only from the checkout and its parents.
 */
const MODEL_SHEET = {
  codex: "$HOME/.codex/pstack-models.md",
  claudeAgent: "$HOME/.claude/pstack-models.md",
  cursor: ".cursor/rules/pstack-models.mdc",
};
type Agent = keyof typeof SKILL_ROOT;
const AGENTS = Object.keys(SKILL_ROOT) as ReadonlyArray<Agent>;
/** Cheapest model per driver; falls back to the driver's default, then its first model. */
const CHEAP_MODEL: Record<Agent, RegExp> = {
  codex: /luna|mini/i,
  claudeAgent: /haiku/i,
  cursor: /^(auto|composer|cheetah)/i,
};
const STEPS = [
  "provision",
  "turns",
  "device",
  "resume",
  "refresh",
  "delete",
  "automation",
] as const;
type Step = (typeof STEPS)[number];

const PROVISION_TIMEOUT = "20 minutes";
const PROJECT_TIMEOUT = "2 minutes";
const PROVIDER_TIMEOUT = "3 minutes";
const TURN_TIMEOUT = "10 minutes";
/** Building the sample app and agent-device's first XCTest runner build take minutes each. */
const DEVICE_TURN_TIMEOUT = "20 minutes";
const RECONNECT_TIMEOUT = "3 minutes";
const PAUSED_TIMEOUT = "2 minutes";
const CALL_TIMEOUT = "2 minutes";
const DISPOSE_TIMEOUT = "3 minutes";
/** Longer than the runner's own 30-minute start limit, so its failure is what the smoke reports. */
const AUTOMATION_START_TIMEOUT = "40 minutes";

const Check = Schema.Struct({
  name: Schema.String,
  pass: Schema.Boolean,
  value: Schema.NullOr(Schema.Union([Schema.Finite, Schema.String])),
  evidence: Schema.Unknown,
});
type Check = typeof Check.Type;
const encodeReport = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      harness: Schema.Literal("smoke-cloud-chat"),
      startedAt: Schema.String,
      finishedAt: Schema.String,
      origin: Schema.String,
      host: Schema.Unknown,
      provider: Schema.String,
      agents: Schema.Array(Schema.String),
      repo: Schema.String,
      steps: Schema.Array(Schema.String),
      box: Schema.Unknown,
      automation: Schema.Unknown,
      managerPhases: Schema.Unknown,
      ok: Schema.Boolean,
      checks: Schema.Array(Check),
    }),
    { space: 2 },
  ),
);
const BearerCache = Schema.fromJsonString(
  Schema.Struct({ origin: Schema.String, accessToken: Schema.String, expiresAt: Schema.Finite }),
);
/** The accounts routing froze for a request, from the manager's preparation manifest. */
const decodeFrozenAccounts = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      request: Schema.Struct({
        providerInstanceId: Schema.String,
        companionInstanceIds: Schema.optional(Schema.Array(Schema.String)),
      }),
    }),
  ),
);
const GitObject = Schema.Struct({ sha: Schema.String });
const decodeGitObject = Schema.decodeUnknownEffect(Schema.fromJsonString(GitObject));
const decodeGitRef = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ object: GitObject })),
);
const decodeGitCommit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ tree: GitObject })),
);
const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);
const decodeWebhookAccepted = Schema.decodeUnknownEffect(
  Schema.Struct({ runId: Schema.String, state: Schema.String }),
);
const decodeBearerCache = Schema.decodeUnknownEffect(BearerCache);
const encodeBearerCache = Schema.encodeEffect(BearerCache);

class SmokeFailure extends Schema.TaggedError<SmokeFailure>()("SmokeFailure", {
  message: Schema.String,
}) {}
/** Not a SmokeFailure: a timeout nobody recorded must still fail the run as `harness`. */
class SmokeTimeout extends Schema.TaggedError<SmokeTimeout>()("SmokeTimeout", {
  message: Schema.String,
}) {}

/** Bounds a call that a stuck cloud API could otherwise hold forever. */
const bounded = <A, E, R>(self: Effect.Effect<A, E, R>, what: string) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () =>
        Effect.fail(new SmokeTimeout({ message: `${what}: no answer in ${CALL_TIMEOUT}` })),
    }),
  );

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));
const describe = (cause: unknown): string => (hasMessage(cause) ? cause.message : String(cause));

const seconds = (from: number, to: number) => Math.round((to - from) / 100) / 10;

const wsUrl = (httpBaseUrl: string) => {
  const url = new URL("ws", httpBaseUrl.endsWith("/") ? httpBaseUrl : `${httpBaseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

const makeClient = RpcClient.make(WsRpcGroup);
type T3Client = typeof makeClient extends Effect.Effect<infer C, infer _E, infer _R> ? C : never;

const decodeWebSocketTicket = Schema.decodeUnknownEffect(
  Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket }),
);

/**
 * Runs `use` with an RPC client whose socket closes when `use` finishes. Every connection, the
 * first and each reconnect, authenticates with a fresh ticket in its URL as the web client does:
 * the manager's gateway to a Namespace box forwards the upgrade URL but not its headers.
 */
const withRpc = <A, E, R>(
  httpBaseUrl: string,
  bearer: string,
  use: (client: T3Client) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const connectUrl = http
      .execute(
        HttpClientRequest.post(new URL("api/auth/websocket-ticket", httpBaseUrl)).pipe(
          HttpClientRequest.bearerToken(bearer),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeWebSocketTicket),
        Effect.map(({ ticket }) => {
          const url = new URL(wsUrl(httpBaseUrl));
          url.searchParams.set("wsTicket", ticket);
          return url.toString();
        }),
        Effect.timeout(CALL_TIMEOUT),
        // Without a ticket the server refuses the upgrade, which the RPC client reports as a
        // socket error on the call that needed it.
        Effect.orElseSucceed(() => wsUrl(httpBaseUrl)),
      );
    return yield* makeClient.pipe(
      Effect.flatMap(use),
      Effect.provide(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(
            Socket.layerWebSocket(connectUrl).pipe(
              Layer.provide(NodeSocket.layerWebSocketConstructor),
            ),
          ),
          Layer.provide(RpcSerialization.layerJson),
        ),
      ),
      Effect.scoped,
    );
  });

const exchangePairingToken = Effect.fn("exchangePairingToken")(function* (
  httpBaseUrl: string,
  credential: string,
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const request = http.execute(
    HttpClientRequest.post(new URL("oauth/token", httpBaseUrl)).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: "cloud smoke",
        client_device_type: "bot",
      }),
    ),
  );
  return yield* bounded(
    request.pipe(
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeAccessToken),
    ),
    "token exchange",
  );
});

/** A driver's agent answers the fixed snippet; these markers prove it ran on the box. */
interface Markers {
  readonly head: string | null;
  readonly branch: string | null;
  readonly origin: string | null;
  readonly skill: string | null;
  readonly flavor: string | null;
  readonly models: string | null;
  readonly nonce: string | null;
}
/** The last `SMOKE_<key>=<value>` the agent printed: a reply may quote the prompt's example first. */
const readMarker = (reply: string, key: string) =>
  [...reply.matchAll(new RegExp(`SMOKE_${key}=[\`'"]?([^\\s\`'"]+)`, "g"))].at(-1)?.[1] ?? null;
const readMarkers = (reply: string): Markers => ({
  head: readMarker(reply, "HEAD"),
  branch: readMarker(reply, "BRANCH"),
  origin: readMarker(reply, "ORIGIN"),
  skill: readMarker(reply, "SKILL"),
  flavor: readMarker(reply, "FLAVOR"),
  models: readMarker(reply, "MODELS"),
  nonce: readMarker(reply, "NONCE"),
});

/** What one turn's thread stream has shown so far, folded the way the projector folds it. */
interface TurnProgress {
  readonly assistant: ReadonlyMap<string, string>;
  readonly firstOutputAt: number | null;
  readonly started: boolean;
  /** The provider turn this message started; a late checkpoint of the previous turn is not ours. */
  readonly turnId: string | null;
  readonly completedAt: number | null;
  readonly error: string | null;
  /** Events at or below the snapshot's sequence are already folded into it. */
  readonly sequence: number;
  /** A session keeps its last error across turns; only a new one belongs to this turn. */
  readonly priorError: string | null;
}
const initialProgress: TurnProgress = {
  assistant: new Map(),
  firstOutputAt: null,
  started: false,
  turnId: null,
  completedAt: null,
  error: null,
  sequence: -1,
  priorError: null,
};
const advanceTurn = (
  progress: TurnProgress,
  item: OrchestrationThreadStreamItem,
  sentMessageId: string,
  now: number,
): TurnProgress => {
  // The subscription opens after dispatch, so the snapshot may already hold the turn's start.
  if (item.kind === "snapshot") {
    const thread = item.snapshot.thread;
    const base = { ...progress, sequence: item.snapshot.snapshotSequence };
    const sent = thread.messages.findIndex((message) => message.id === sentMessageId);
    if (sent === -1) return { ...base, priorError: thread.session?.lastError ?? null };
    const replies = thread.messages
      .slice(sent + 1)
      .filter((message) => message.role === "assistant");
    const turn = thread.latestTurn;
    const sentTurnId = thread.messages[sent]!.turnId;
    const ours =
      turn !== null &&
      (sentTurnId !== null
        ? turn.turnId === sentTurnId
        : turn.requestedAt >= thread.messages[sent]!.createdAt);
    const finished = ours && turn.state !== "running";
    return {
      ...base,
      assistant: new Map(replies.map((message) => [message.id, message.text])),
      firstOutputAt: replies.some((message) => message.text.trim()) ? now : null,
      started: true,
      turnId: ours ? turn.turnId : null,
      completedAt: finished ? now : null,
      error:
        finished && turn.state === "error" ? (thread.session?.lastError ?? "turn error") : null,
      priorError: ours ? null : (thread.session?.lastError ?? null),
    };
  }
  if (item.kind !== "event" || item.event.sequence <= progress.sequence) return progress;
  const event = item.event;
  switch (event.type) {
    case "thread.message-sent": {
      if (event.payload.role !== "assistant") return progress;
      const previous = progress.assistant.get(event.payload.messageId) ?? "";
      const text = event.payload.streaming
        ? previous + event.payload.text
        : event.payload.text || previous;
      const assistant = new Map(progress.assistant).set(event.payload.messageId, text);
      return {
        ...progress,
        assistant,
        firstOutputAt: progress.firstOutputAt ?? (text.trim() ? now : null),
      };
    }
    case "thread.turn-start-requested":
      return event.payload.messageId === sentMessageId ? { ...progress, started: true } : progress;
    case "thread.session-set": {
      const session = event.payload.session;
      if (!progress.started) return progress;
      const newError = session.lastError !== null && session.lastError !== progress.priorError;
      if (session.status === "error" || newError)
        return { ...progress, error: session.lastError ?? "session error", completedAt: now };
      if (session.status === "running" && progress.turnId === null && session.activeTurnId !== null)
        return { ...progress, turnId: session.activeTurnId };
      const settled = session.activeTurnId === null && session.status !== "starting";
      return settled && session.status !== "running" && progress.firstOutputAt !== null
        ? { ...progress, completedAt: progress.completedAt ?? now }
        : progress;
    }
    case "thread.turn-diff-completed":
      return progress.turnId !== null && event.payload.turnId === progress.turnId
        ? { ...progress, completedAt: progress.completedAt ?? now }
        : progress;
    default:
      return progress;
  }
};

/**
 * The manager logs each provisioning phase as a `provision phase` line followed by indented
 * `key: value` annotations; this reads back the ones for one request, in order.
 */
const readManagerPhases = (log: string, requestId: string) => {
  const entries: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of log.split("\n")) {
    if (line.endsWith(": provision phase")) {
      current = {};
      entries.push(current);
      continue;
    }
    const field = current ? line.match(/^ {2}(\w+): (.*)$/) : null;
    if (current && field) current[field[1]!] = field[2]!;
    else current = null;
  }
  return entries
    .filter((entry) => entry.requestId === requestId)
    .map((entry) => ({
      phase: entry.phase ?? "",
      durationMs: Math.round(Number(entry.durationMs)),
      ...(entry.bytes ? { bytes: Number(entry.bytes) } : {}),
      ...(entry.failed === "true" ? { failed: true } : {}),
    }));
};

interface Options {
  readonly origin: string;
  readonly pairingTokenFile: string;
  readonly provider: "e2b" | "namespace";
  readonly agents: ReadonlyArray<Agent>;
  readonly repo: string;
  readonly steps: ReadonlySet<Step>;
  readonly deviceAgent: Agent;
  readonly managerLog: string | null;
  readonly managerState: string | null;
  readonly report: string;
}

/** The fullest usage window, the one routing judges an account by; null when none is known. */
const mostUsedPercent = (provider: ServerProvider | undefined) =>
  provider?.usageLimits?.windows.length
    ? Math.max(...provider.usageLimits.windows.map((window) => window.usedPercent))
    : null;

const smoke = Effect.fn("smokeCloudChat")(function* (options: Options) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const startedAt = DateTime.formatIso(yield* DateTime.now);
  const runStart = yield* Clock.currentTimeMillis;
  const checks: Array<Check> = [];
  const record = (name: string, pass: boolean, value: Check["value"], evidence: unknown = null) =>
    Effect.gen(function* () {
      checks.push({ name, pass, value, evidence });
      const at = seconds(runStart, yield* Clock.currentTimeMillis);
      yield* Console.log(`[${at}s] ${pass ? "PASS" : "FAIL"} ${name} ${value ?? ""}`);
    });
  /** Records a failed check and stops the current step. */
  const fail = (name: string, message: string, evidence: unknown = null) =>
    record(name, false, null, { error: message, ...(evidence ? { detail: evidence } : {}) }).pipe(
      Effect.andThen(Effect.fail(new SmokeFailure({ message: `${name}: ${message}` }))),
    );
  const uuid = crypto.randomUUIDv4;
  const sha256 = (value: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(
        Effect.map((bytes) =>
          Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        ),
      );

  const bearerFor = Effect.fn("bearerFor")(function* () {
    const cachePath = `${options.pairingTokenFile}.bearer.json`;
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* fs
      .readFileString(cachePath)
      .pipe(Effect.flatMap(decodeBearerCache), Effect.option);
    if (
      Option.isSome(cached) &&
      cached.value.origin === options.origin &&
      cached.value.expiresAt - now > 15 * 60_000
    ) {
      yield* record("auth.bearer", true, "cached", {
        expiresInMinutes: Math.round((cached.value.expiresAt - now) / 60_000),
      });
      return cached.value.accessToken;
    }
    const credential = (yield* fs.readFileString(options.pairingTokenFile)).trim();
    const token = yield* exchangePairingToken(options.origin, credential).pipe(
      Effect.catch((cause) => fail("auth.bearer", `token exchange refused: ${describe(cause)}`)),
    );
    const expiresAt = now + token.expires_in * 1000;
    yield* fs.writeFileString(
      cachePath,
      yield* encodeBearerCache({
        origin: options.origin,
        accessToken: token.access_token,
        expiresAt,
      }),
      { mode: 0o600 },
    );
    yield* fs.chmod(cachePath, 0o600);
    yield* record("auth.bearer", true, "exchanged", {
      scope: token.scope,
      expiresInMinutes: Math.round(token.expires_in / 60),
    });
    return token.access_token;
  });

  const host = yield* HttpClient.get(new URL(".well-known/t3/environment", options.origin)).pipe(
    Effect.flatMap((response) => response.json),
    Effect.catch((cause) => Effect.succeed({ unreachable: describe(cause) })),
  );

  interface ChildThread {
    readonly agent: Agent;
    readonly threadId: ThreadId;
  }
  /** What this run created, so cleanup finds it whichever step failed. */
  const created: {
    requestId: ProvisionRequestId | null;
    box: ProvisionedEnvironment | null;
    child: { readonly httpBaseUrl: string; readonly bearer: string } | null;
    projectId: ProjectId | null;
    workspaceRoot: string | null;
    readonly threads: Array<ChildThread>;
    /** The branch the box follows on GitHub: the default, or the scratch branch under `refresh`. */
    branch: string | null;
    /** The box's HEAD: the tip it was prepared at, which resume never moves. */
    head: string | null;
  } = {
    requestId: null,
    box: null,
    child: null,
    projectId: null,
    workspaceRoot: null,
    threads: [],
    branch: null,
    head: null,
  };

  /** Under `refresh`, a branch made for this run, so the smoke can commit to what the box follows. */
  const scratch = options.steps.has("refresh")
    ? `smoke/refresh-${(yield* uuid).slice(0, 8)}`
    : null;

  /**
   * `branch` (the default branch when null) and its tip on GitHub now; failing records `check` as
   * failed.
   */
  const remoteTip = Effect.fn("remoteTip")(function* (check: string, branch: string | null) {
    const output = yield* bounded(
      spawner.string(
        ChildProcess.make("git", [
          "ls-remote",
          ...(branch ? [] : ["--symref"]),
          `https://github.com/${options.repo}`,
          branch ? `refs/heads/${branch}` : "HEAD",
        ]),
      ),
      "git ls-remote",
    ).pipe(Effect.catch((cause) => fail(check, `git ls-remote: ${describe(cause)}`)));
    if (branch) {
      const sha = output.match(/^([0-9a-f]{40})\t/m)?.[1];
      if (!sha) return yield* fail(check, "unparseable git ls-remote output", { output });
      return { branch, sha };
    }
    const parsed = output.match(/^ref: refs\/heads\/(\S+)\tHEAD\n([0-9a-f]+)\tHEAD$/m);
    if (!parsed) return yield* fail(check, "unparseable git ls-remote output", { output });
    return { branch: parsed[1]!, sha: parsed[2]! };
  });

  /** Calls the GitHub API as the local gh CLI's user; a refusal fails with GitHub's answer. */
  const gh = <A>(
    decode: (output: string) => Effect.Effect<A, Schema.SchemaError>,
    endpoint: string,
    ...fields: ReadonlyArray<string>
  ) =>
    bounded(spawner.string(ChildProcess.make("gh", ["api", endpoint, ...fields])), "gh api").pipe(
      Effect.flatMap((output) =>
        decode(output).pipe(
          Effect.mapError(
            () => new SmokeFailure({ message: `gh api ${endpoint}: ${output.slice(0, 300)}` }),
          ),
        ),
      ),
    );

  /** Cleanup deletes the scratch branch only once this run has made it. */
  let scratchCreated = false;
  const createScratch = Effect.fn("createScratch")(function* (branch: string) {
    const base = yield* remoteTip("refresh.branch", null);
    const made = yield* gh(
      decodeGitRef,
      `repos/${options.repo}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${base.sha}`,
    ).pipe(Effect.catch((cause) => fail("refresh.branch", describe(cause))));
    scratchCreated = true;
    yield* record("refresh.branch", made.object.sha === base.sha, branch, { from: base });
  });

  /** Fast-forwards the scratch branch by one commit and returns the new tip. */
  const advanceScratch = Effect.fn("advanceScratch")(function* (branch: string) {
    const repo = `repos/${options.repo}`;
    const parent = (yield* gh(decodeGitRef, `${repo}/git/ref/heads/${branch}`)).object.sha;
    const base = yield* gh(decodeGitCommit, `${repo}/git/commits/${parent}`);
    const tree = yield* gh(
      decodeGitObject,
      `${repo}/git/trees`,
      "-f",
      `base_tree=${base.tree.sha}`,
      "-f",
      `tree[][path]=${branch}.txt`,
      "-f",
      "tree[][mode]=100644",
      "-f",
      "tree[][type]=blob",
      "-f",
      `tree[][content]=${branch}\n`,
    );
    const commit = yield* gh(
      decodeGitObject,
      `${repo}/git/commits`,
      "-f",
      `message=${branch}: a commit the box must pick up on resume`,
      "-f",
      `tree=${tree.sha}`,
      "-f",
      `parents[]=${parent}`,
    );
    const moved = yield* gh(
      decodeGitRef,
      `${repo}/git/refs/heads/${branch}`,
      "-X",
      "PATCH",
      "-f",
      `sha=${commit.sha}`,
      "-F",
      "force=false",
    );
    if (moved.object.sha !== commit.sha)
      return yield* new SmokeFailure({ message: `the branch sits on ${moved.object.sha}` });
    return { parent, sha: commit.sha };
  });

  const deleteScratch = Effect.fn("deleteScratch")(function* (branch: string) {
    const exit = yield* bounded(
      spawner.exitCode(
        ChildProcess.make("gh", [
          "api",
          "-X",
          "DELETE",
          `repos/${options.repo}/git/refs/heads/${branch}`,
        ]),
      ),
      "gh api",
    ).pipe(Effect.catch((cause) => Effect.succeed(describe(cause))));
    yield* record(
      "refresh.cleanup",
      exit === 0,
      branch,
      typeof exit === "string" ? { error: exit } : { exitCode: exit },
    );
  });

  const awaitProvider = Effect.fn("awaitProvider")(function* (
    client: T3Client,
    agent: Agent,
    label: string,
  ) {
    let last: ServerProvider | undefined;
    const found = yield* Effect.gen(function* () {
      const config = yield* client["server.getConfig"]({});
      last = config.providers.find((provider) => provider.driver === agent && provider.enabled);
      return last && last.models.length > 0 && last.status !== "error" ? last : undefined;
    }).pipe(
      Effect.repeat({
        until: (provider) => provider !== undefined,
        schedule: Schedule.spaced("3 seconds"),
      }),
      Effect.timeoutOption(PROVIDER_TIMEOUT),
    );
    if (Option.isSome(found) && found.value) return found.value;
    return yield* fail(`${label}.provider`, "no usable provider instance on the child", {
      instanceId: last?.instanceId ?? null,
      status: last?.status ?? null,
      auth: last?.auth.status ?? null,
      message: last?.message ?? null,
      models: last?.models.length ?? 0,
    });
  });

  /**
   * Sends one turn, waits for it to finish, and records its first output and completion under
   * `label`. `cheap` picks the driver's cheapest model; otherwise its default.
   */
  const sendTurn = Effect.fn("sendTurn")(function* (
    client: T3Client,
    agent: Agent,
    label: string,
    thread: ChildThread | null,
    prompt: string,
    options: {
      readonly cheap: boolean;
      readonly timeout: Duration.Input;
      readonly onDispatched?: (threadId: ThreadId) => Effect.Effect<void>;
    },
  ) {
    const provider = yield* awaitProvider(client, agent, label);
    const model =
      (options.cheap
        ? provider.models.find((candidate) => CHEAP_MODEL[agent].test(candidate.slug))
        : undefined) ??
      provider.models.find((candidate) => candidate.isDefault) ??
      provider.models[0]!;
    const modelSelection = {
      instanceId: ProviderInstanceId.make(provider.instanceId),
      model: model.slug,
    };
    const threadId = thread?.threadId ?? ThreadId.make(yield* uuid);
    const messageId = MessageId.make(yield* uuid);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const projectId = created.projectId!;
    const sentAt = yield* Clock.currentTimeMillis;
    const dispatch = client["orchestration.dispatchCommand"]({
      type: "thread.turn.start",
      commandId: CommandId.make(yield* uuid),
      threadId,
      message: { messageId, role: "user", text: prompt, attachments: [] },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      ...(thread
        ? {}
        : {
            bootstrap: {
              createThread: {
                projectId,
                title: `smoke ${label}`,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
          }),
      createdAt,
    });
    yield* bounded(dispatch, "dispatch").pipe(
      Effect.catch((cause) => fail(`${label}.dispatch`, describe(cause))),
    );
    const turnThread = thread ?? { agent, threadId };
    if (!thread) created.threads.push(turnThread);
    if (options.onDispatched) yield* options.onDispatched(threadId);

    let progress = initialProgress;
    const watched = yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
      Stream.runForEachWhile((item) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            progress = advanceTurn(progress, item, messageId, now);
            return progress.completedAt === null;
          }),
        ),
      ),
      Effect.timeoutOption(options.timeout),
      Effect.map((finished) => (Option.isSome(finished) ? null : "turn did not finish in time")),
      Effect.catch((cause) => Effect.succeed(describe(cause))),
    );
    const reply = [...progress.assistant.values()].join("\n");
    const evidence = {
      threadId,
      instanceId: provider.instanceId,
      model: model.slug,
      models: provider.models.map((candidate) => candidate.slug),
      replyTail: reply.slice(-600),
    };
    const error = progress.error ?? watched;
    yield* record(
      `${label}.firstOutput`,
      progress.firstOutputAt !== null,
      progress.firstOutputAt === null ? null : seconds(sentAt, progress.firstOutputAt),
      progress.firstOutputAt === null
        ? { ...evidence, error: error ?? "no assistant output" }
        : evidence,
    );
    const completed = progress.completedAt !== null && progress.error === null;
    yield* record(
      `${label}.complete`,
      completed,
      completed ? seconds(sentAt, progress.completedAt!) : null,
      { threadId, error },
    );
    return { reply, firstOutputAt: progress.firstOutputAt, thread: turnThread };
  });

  /**
   * The shell line whose output proves an agent ran on the box: its checkout, skills and a nonce.
   * The agent cannot print the nonce without running it: only the seed's sha256 prefix counts.
   */
  const markerSnippet = Effect.fn("markerSnippet")(function* (agent: Agent) {
    const seed = (yield* uuid).replaceAll("-", "");
    const expectedNonce = (yield* sha256(seed)).slice(0, 16);
    const snippet = [
      `h=$(git rev-parse HEAD); b=$(git rev-parse --abbrev-ref HEAD); s=missing`,
      `o=$(git rev-parse -q --verify refs/remotes/origin/${created.branch} || echo missing)`,
      `test -f "$HOME/${SKILL_ROOT[agent]}/poteto-mode/SKILL.md" && s=present`,
      `f=cursor; test -f "$HOME/${SKILL_ROOT[agent]}/poteto-mode/references/codex-tools.md" && f=codex-adapted`,
      `test -f "$HOME/${SKILL_ROOT[agent]}/poteto-mode/scripts/github-merge-queue-label.sh" || f=$f-no-overlay`,
      ...(agent === "claudeAgent"
        ? [`test -f "$HOME/.claude/agents/poteto-agent.md" || f=$f-no-agent`]
        : []),
      `m=missing; test -f "${MODEL_SHEET[agent]}" && m=present; git check-ignore -q "${MODEL_SHEET[agent]}" 2>/dev/null && m=$m-ignored`,
      `n=$(printf %s ${seed} | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-16)`,
      `echo "SMOKE_HEAD=$h SMOKE_BRANCH=$b SMOKE_ORIGIN=$o SMOKE_SKILL=$s SMOKE_FLAVOR=$f SMOKE_MODELS=$m SMOKE_NONCE=$n"`,
    ].join("; ");
    return { snippet, expectedNonce };
  });

  /** Sends one marker turn and records its checks under `label`. */
  const runTurn = Effect.fn("runTurn")(function* (
    client: T3Client,
    agent: Agent,
    label: string,
    thread: ChildThread | null,
    onDispatched?: (threadId: ThreadId) => Effect.Effect<void>,
  ) {
    const { snippet, expectedNonce } = yield* markerSnippet(agent);
    const prompt = `Run this exact shell command in the workspace with your shell tool, then reply with the single line it prints, verbatim, and nothing else:\n\n${snippet}`;
    const turn = yield* sendTurn(client, agent, label, thread, prompt, {
      cheap: true,
      timeout: TURN_TIMEOUT,
      ...(onDispatched ? { onDispatched } : {}),
    });
    const markers = readMarkers(turn.reply);
    yield* record(`${label}.markers`, markers.nonce === expectedNonce, markers.nonce, {
      expectedNonce,
      markers,
    });
    yield* record(
      `${label}.checkout`,
      markers.head !== null && markers.head === created.head,
      markers.head,
      { expected: created.head, branch: markers.branch, origin: markers.origin },
    );
    yield* record(`${label}.skill`, markers.skill === "present", markers.skill, {
      path: `$HOME/${SKILL_ROOT[agent]}/poteto-mode/SKILL.md`,
    });
    // Which pstack bundle and model sheet the box carries depends on the host's config, so these
    // only require that the agent reported them; the report keeps the values.
    yield* record(`${label}.pstack`, markers.flavor !== null, markers.flavor, {});
    yield* record(`${label}.models`, markers.models !== null, markers.models, {
      path: MODEL_SHEET[agent],
    });
    return { ...turn, markers };
  });

  /**
   * Records the account each agent ran on the box: the child's instance, named by the manager and
   * signed in on the box, against the account routing froze for it, and whether it had usage left.
   * Without `--manager-state` only the chat's own account is known to routing's record.
   */
  const accounts = Effect.fn("accounts")(function* (manager: T3Client, child: T3Client) {
    const box = created.box!;
    const managerProviders = (yield* bounded(manager["server.getConfig"]({}), "manager config"))
      .providers;
    const childProviders = (yield* bounded(child["server.getConfig"]({}), "child config"))
      .providers;
    const frozen =
      options.managerState && created.requestId
        ? yield* fs
            .readFileString(
              path.join(options.managerState, "provisioning", `${created.requestId}.json`),
            )
            .pipe(Effect.flatMap(decodeFrozenAccounts), Effect.option)
        : Option.none();
    const routedIds = Option.match(frozen, {
      onNone: () => [box.providerInstanceId],
      onSome: ({ request }) => [
        request.providerInstanceId,
        ...(request.companionInstanceIds ?? []),
      ],
    });
    for (const agent of options.agents) {
      const onBox = childProviders.find(
        (provider) => provider.driver === agent && provider.enabled,
      );
      const account = managerProviders.find(
        (provider) =>
          provider.driver === agent &&
          provider.displayName !== undefined &&
          provider.displayName === onBox?.displayName,
      );
      const routed =
        routedIds.find(
          (id) => managerProviders.find((provider) => provider.instanceId === id)?.driver === agent,
        ) ?? null;
      const knowsRouting = routed !== null || Option.isSome(frozen);
      const email = onBox?.auth.email ?? null;
      const used = mostUsedPercent(account);
      const usedOnBox = mostUsedPercent(onBox);
      // A weekly window resets at a fixed time per account, so the box and the manager disagree
      // on it only when the box signed in as someone else. A Claude token carries no email.
      const resetMismatches = (onBox?.usageLimits?.windows ?? []).filter((window) => {
        const managed = account?.usageLimits?.windows.find(({ id }) => id === window.id);
        return (
          window.kind === "weekly" &&
          window.resetsAt !== undefined &&
          managed?.resetsAt !== undefined &&
          Math.abs(Date.parse(window.resetsAt) - Date.parse(managed.resetsAt)) > 60 * 60_000
        );
      });
      const windows = (provider: ServerProvider | undefined) =>
        provider?.usageLimits?.windows.map(({ id, usedPercent, resetsAt }) => ({
          id,
          usedPercent,
          resetsAt: resetsAt ?? null,
        })) ?? null;
      yield* record(
        `account.${agent}`,
        account !== undefined &&
          (!knowsRouting || account.instanceId === routed) &&
          onBox?.auth.status === "authenticated" &&
          (email === null || onBox.displayName!.includes(email)) &&
          resetMismatches.length === 0 &&
          (used ?? 0) < 100 &&
          (usedOnBox ?? 0) < 100,
        account?.instanceId ?? null,
        {
          routed,
          routedFrom: Option.isSome(frozen) ? "manifest" : routed ? "provision" : null,
          onBox: onBox
            ? {
                instanceId: onBox.instanceId,
                displayName: onBox.displayName ?? null,
                auth: onBox.auth,
                mostUsedPercent: usedOnBox,
                windows: windows(onBox),
              }
            : null,
          managerMostUsedPercent: used,
          managerWindows: windows(account),
          managerUsageCheckedAt: account?.usageLimits?.checkedAt ?? null,
          resetMismatches: resetMismatches.map(({ id }) => id),
        },
      );
    }
  });

  /**
   * Pairs this run with a box the manager provisioned, the way a client does: attach mints a
   * one-time pairing URL, a loopback one goes through the manager's guest gateway, and the
   * credential is exchanged for a bearer on the box.
   */
  const pairChild = Effect.fn("pairChild")(function* (
    manager: T3Client,
    check: string,
    box: {
      readonly requestId: ProvisionRequestId;
      readonly leaseId: string;
      readonly environmentId: string;
    },
  ) {
    const attached = yield* bounded(
      manager["environmentControl.attach"]({ requestId: box.requestId }),
      "attach",
    );
    if (attached.kind !== "attached")
      return yield* fail(check, `attach refused: ${attached.message}`);
    if (attached.environmentId !== box.environmentId)
      return yield* fail(check, "attach returned another environment");
    // A loopback pairing URL is only reachable through the manager's guest gateway.
    // Parse failures would carry the pairing URL, so they surface without it.
    const minted = yield* Effect.try({
      try: () => new URL(attached.pairingUrl),
      catch: () => new SmokeFailure({ message: `${check}: attach returned an invalid URL` }),
    });
    const gateway = isLoopbackHost(minted.hostname);
    const pairingUrl = gateway
      ? Object.assign(new URL(options.origin), {
          pathname: `${PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX}/${encodeURIComponent(box.leaseId)}/pair`,
          search: minted.search,
          hash: minted.hash,
        }).toString()
      : attached.pairingUrl;
    const target = yield* Effect.try({
      try: () => resolveRemotePairingTarget({ pairingUrl }),
      catch: () => new SmokeFailure({ message: `${check}: pairing URL has no usable target` }),
    });
    const childToken = yield* exchangePairingToken(target.httpBaseUrl, target.credential).pipe(
      Effect.catch((cause) => fail(check, `child token exchange: ${describe(cause)}`)),
    );
    return { httpBaseUrl: target.httpBaseUrl, bearer: childToken.access_token, gateway };
  });

  const provision = Effect.fn("provision")(function* (manager: T3Client) {
    const config = yield* manager["server.getConfig"]({}).pipe(
      Effect.timeoutOption("30 seconds"),
      Effect.catch((cause) => Effect.succeed(describe(cause))),
    );
    if (typeof config === "string" || Option.isNone(config))
      return yield* fail(
        "manager.connect",
        typeof config === "string" ? config : "no answer in 30s",
      );
    const primary = options.agents[0]!;
    const instance = config.value.providers.find(
      (provider) => provider.driver === primary && provider.enabled,
    );
    if (!instance) return yield* fail("provision.ready", `the manager has no ${primary} account`);
    // A new-chat draft on the host lists these, so they must match what the box gets.
    for (const agent of options.agents) {
      const skills = config.value.provisionedSkills?.[agent];
      yield* record(
        `host.skills.${agent}`,
        skills?.some((skill) => skill.name === "poteto-mode") === true,
        skills?.length ?? null,
      );
    }
    const requestId = ProvisionRequestId.make(yield* uuid);
    created.requestId = requestId;
    const input = {
      requestId,
      provider: options.provider,
      providerInstanceId: instance.instanceId,
      agentDriver: ProviderDriverKind.make(primary),
      repository: options.repo,
      ...(scratch ? { branch: scratch } : {}),
    };
    const tipBefore = yield* remoteTip("provision.sourceRevision", scratch);
    const started = yield* Clock.currentTimeMillis;
    const phases: Array<{ readonly at: number; readonly kind: string; readonly message: string }> =
      [];
    const result = yield* Effect.gen(function* () {
      const response = yield* manager["environmentControl.provision"](input);
      const message = response.kind === "ready" ? "" : response.message;
      const last = phases.at(-1);
      if (last?.kind !== response.kind || last.message !== message)
        phases.push({
          at: seconds(started, yield* Clock.currentTimeMillis),
          kind: response.kind,
          message,
        });
      return response;
    }).pipe(
      Effect.repeat({
        while: (response) => response.kind === "pending" || response.kind === "allocation_unknown",
        schedule: Schedule.spaced("5 seconds"),
      }),
      Effect.timeoutOption(PROVISION_TIMEOUT),
      Effect.catch((cause) => fail("provision.ready", describe(cause), { phases })),
    );
    if (Option.isNone(result))
      return yield* fail("provision.ready", `not ready after ${PROVISION_TIMEOUT}`, { phases });
    if (result.value.kind !== "ready")
      return yield* fail("provision.ready", `provision ${result.value.kind}`, { phases });
    const readyAt = yield* Clock.currentTimeMillis;
    const box = result.value.environment;
    created.box = box;
    yield* record("provision.ready", true, seconds(started, readyAt), {
      requestId,
      phases,
      leaseId: box.leaseId,
      sandboxId: box.sandboxId,
      environmentId: box.environmentId,
      providerInstanceId: box.providerInstanceId,
      sourceRevision: box.sourceRevision,
      t3Revision: box.t3Revision,
    });
    const tipAfter = yield* remoteTip("provision.sourceRevision", scratch);
    created.branch = tipAfter.branch;
    created.head = box.sourceRevision;
    yield* record(
      "provision.sourceRevision",
      box.sourceRevision !== null && [tipBefore.sha, tipAfter.sha].includes(box.sourceRevision),
      box.sourceRevision,
      { tipBefore, tipAfter },
    );

    const child = yield* pairChild(manager, "child.paired", {
      requestId,
      leaseId: box.leaseId,
      environmentId: box.environmentId,
    });
    created.child = { httpBaseUrl: child.httpBaseUrl, bearer: child.bearer };
    return { readyAt, gateway: child.gateway, childHost: new URL(child.httpBaseUrl).host };
  });

  const turns = Effect.fn("turns")(function* (
    manager: T3Client,
    paired: { readonly readyAt: number; readonly gateway: boolean; readonly childHost: string },
  ) {
    const box = created.box!;
    const access = created.child!;
    yield* withRpc(access.httpBaseUrl, access.bearer, (client) =>
      Effect.gen(function* () {
        const config = yield* client["server.getConfig"]({}).pipe(
          Effect.timeoutOption("1 minute"),
          Effect.catch((cause) => fail("child.paired", describe(cause))),
        );
        if (Option.isNone(config)) return yield* fail("child.paired", "child did not answer in 1m");
        const pairedAt = yield* Clock.currentTimeMillis;
        yield* record("child.paired", true, seconds(paired.readyAt, pairedAt), {
          gateway: paired.gateway,
          childHost: paired.childHost,
          environmentId: config.value.environment.environmentId,
          providers: config.value.providers
            .filter((provider) => provider.enabled)
            .map((provider) => `${provider.instanceId}:${provider.status}/${provider.auth.status}`),
        });
        const project = yield* client["orchestration.subscribeShell"]({}).pipe(
          Stream.flatMap((item) =>
            Stream.fromIterable(
              item.kind === "snapshot"
                ? item.snapshot.projects
                : item.kind === "project-upserted"
                  ? [item.project]
                  : [],
            ),
          ),
          Stream.runHead,
          Effect.timeoutOption(PROJECT_TIMEOUT),
        );
        if (Option.isNone(project) || Option.isNone(project.value))
          return yield* fail("child.project", `no project after ${PROJECT_TIMEOUT}`);
        created.projectId = project.value.value.id;
        created.workspaceRoot = project.value.value.workspaceRoot;
        yield* record("child.project", true, seconds(pairedAt, yield* Clock.currentTimeMillis), {
          projectId: created.projectId,
          workspaceRoot: created.workspaceRoot,
        });
        // The web claims the lease for the chat that first sends on the box, right after sending.
        const claim = (threadId: ThreadId) =>
          created.threads.length !== 1
            ? Effect.void
            : bounded(
                manager["environmentControl.claim"]({
                  leaseId: box.leaseId,
                  environmentId: box.environmentId,
                  threadId,
                }),
                "claim",
              ).pipe(
                Effect.catch((cause) => Effect.succeed({ kind: describe(cause) })),
                Effect.flatMap((claimed) =>
                  record("lease.claim", claimed.kind === "claimed", claimed.kind, claimed),
                ),
              );
        if (options.steps.has("turns"))
          for (const agent of options.agents)
            yield* runTurn(client, agent, `turn.${agent}`, null, claim).pipe(
              Effect.catchTag("SmokeFailure", () => Effect.void),
              Effect.catch((cause) =>
                record(`turn.${agent}`, false, null, { error: describe(cause) }),
              ),
            );
        if (options.steps.has("turns"))
          yield* accounts(manager, client).pipe(
            Effect.catch((cause) => record("account", false, null, { error: describe(cause) })),
          );
        if (options.steps.has("device")) yield* device(client, claim);
      }),
    );
  });

  /** Fetches a file on the box through a signed media URL at the address clients load it from. */
  const fetchMedia = Effect.fn("fetchMedia")(function* (
    client: T3Client,
    threadId: ThreadId,
    path: string,
  ) {
    const access = created.child!;
    const asset = yield* bounded(
      client["assets.createUrl"]({ resource: { _tag: "media-file", threadId, path } }),
      "assets.createUrl",
    );
    const url = resolveAssetUrl(access.httpBaseUrl, asset.relativeUrl);
    if (url === null)
      return yield* new SmokeFailure({ message: "clients cannot resolve the asset URL" });
    const response = yield* bounded(HttpClient.get(url), "media fetch");
    const bytes = new Uint8Array(yield* bounded(response.arrayBuffer, "media body"));
    const { pathname } = new URL(url);
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? null,
      bytes,
      // The signed segment reads the file until it expires; the report keeps only the route.
      pathname: pathname.replace(/\/api\/assets\/[^/]+\//, "/api/assets/<signed>/"),
      insideChild: pathname.startsWith(new URL(access.httpBaseUrl).pathname),
    };
  });

  /**
   * Drives an iPhone simulator on a Namespace Mac the way an agent in a chat would: one turn per
   * capability in a single thread, each timed and checked against what it left on the box.
   */
  const device = Effect.fn("device")(function* (
    client: T3Client,
    claim: (threadId: ThreadId) => Effect.Effect<void>,
  ) {
    const agent = options.deviceAgent;
    const run = (yield* uuid).replaceAll("-", "").slice(0, 12);
    const dir = `/tmp/t3-smoke-device-${run}`;
    const bundleId = `dev.t3.smoke.s${run}`;
    const expectedLldb = `SMOKE_LLDB_${[...run].toReversed().join("")}`;
    let thread: ChildThread | null = null;
    const step = (name: string, prompt: string) =>
      sendTurn(client, agent, `device.${name}`, thread, prompt, {
        cheap: false,
        timeout: DEVICE_TURN_TIMEOUT,
        ...(thread === null ? { onDispatched: claim } : {}),
      }).pipe(
        Effect.tap((turn) =>
          Effect.sync(() => {
            thread = turn.thread;
          }),
        ),
      );
    const fileCheck = (
      name: string,
      turn: { readonly thread: ChildThread },
      path: string,
      contentType: string,
      isValid: (bytes: Uint8Array) => boolean,
    ) =>
      fetchMedia(client, turn.thread.threadId, path).pipe(
        Effect.flatMap((file) =>
          record(
            `device.${name}.file`,
            file.status === 200 && file.bytes.length > 0 && isValid(file.bytes),
            file.bytes.length,
            {
              path,
              status: file.status,
              head: Array.from(file.bytes.slice(0, 12), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            },
          ).pipe(
            Effect.andThen(
              record(
                `device.${name}.clientUrl`,
                file.insideChild &&
                  file.status === 200 &&
                  file.contentType?.split(";")[0]?.trim() === contentType &&
                  file.bytes.length > 0,
                file.status,
                {
                  pathname: file.pathname,
                  insideChild: file.insideChild,
                  contentType: file.contentType,
                  expectedContentType: contentType,
                  bytes: file.bytes.length,
                },
              ),
            ),
          ),
        ),
        Effect.catch((cause) =>
          record(`device.${name}.file`, false, null, { path, error: describe(cause) }),
        ),
      );

    const boot = yield* step(
      "boot",
      [
        `This chat smoke-tests iOS simulator control on this Mac. Use the t3-code MCP device tools and the agent-device command they return; keep every file you create under ${dir}. Run every command in the foreground and wait for it to finish: no background tasks or subagents.`,
        `Now call device_open for an iPhone simulator (platform ios). Keep the agentDevice command and targetArgs it returns for every agent-device call in later messages.`,
        `Reply with one line: SMOKE_DEVICE=<the simulator udid>`,
      ].join("\n\n"),
    );
    const udid = readMarker(boot.reply, "DEVICE");
    const listed = yield* bounded(client["device.list"]({ inspectOnly: true }), "device.list").pipe(
      Effect.map((state) => state.devices.find((candidate) => candidate.id === udid) ?? null),
      Effect.catch((cause) => Effect.succeed(describe(cause))),
    );
    yield* record(
      "device.boot.booted",
      typeof listed === "object" && listed !== null && listed.booted,
      udid,
      { listed },
    );

    const app = yield* step(
      "app",
      [
        `Write a minimal single-file iPhone app under ${dir}/app with bundle identifier ${bundleId}. It shows the text "T3 smoke ${run}" and runs a repeating one-second Timer that calls a function tick(). Inside tick(), on its own line, assign: let marker = "SMOKE_LLDB_" + String("${run}".reversed())`,
        `Build it for the iOS simulator with debug info and no optimization (-g -Onone), keeping its .dSYM next to the .app so LLDB can find it later. Install it on the booted simulator with agent-device and open ${bundleId} with agent-device so it is running in the foreground.`,
        `Reply with one line: SMOKE_APP=<the bundle identifier now running>`,
      ].join("\n\n"),
    );
    yield* record(
      "device.app.markers",
      readMarker(app.reply, "APP") === bundleId,
      readMarker(app.reply, "APP"),
      {
        expected: bundleId,
      },
    );

    const shot = yield* step(
      "screenshot",
      `Take a screenshot of the simulator with agent-device and save it as ${dir}/screenshot.png. Reply with one line: SMOKE_SCREENSHOT=${dir}/screenshot.png`,
    );
    yield* fileCheck(
      "screenshot",
      shot,
      `${dir}/screenshot.png`,
      "image/png",
      (bytes) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
    );

    const video = yield* step(
      "record",
      `Record about three seconds of the simulator screen with agent-device record (start, wait, stop) and save the video as ${dir}/recording.mp4, moving it there if agent-device writes it elsewhere. Reply with one line: SMOKE_VIDEO=${dir}/recording.mp4`,
    );
    yield* fileCheck(
      "record",
      video,
      `${dir}/recording.mp4`,
      "video/mp4",
      (bytes) => new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp",
    );

    const debug = yield* step(
      "lldb",
      [
        `Attach LLDB to the running ${bundleId} app process. Set a breakpoint on the line in tick() that assigns marker, continue until the process stops there, step over that line, print marker, then detach so the app keeps running.`,
        `Run LLDB non-interactively (for example lldb --batch with -o commands) and save its complete output to ${dir}/lldb.txt.`,
        `Reply with one line: SMOKE_LLDB=<the value LLDB printed for marker> SMOKE_LLDB_AT=<file:line of the breakpoint>`,
      ].join("\n\n"),
    );
    yield* record(
      "device.lldb.marker",
      readMarker(debug.reply, "LLDB") === expectedLldb,
      readMarker(debug.reply, "LLDB"),
      {
        expected: expectedLldb,
        at: readMarker(debug.reply, "LLDB_AT"),
      },
    );
    const transcript = yield* bounded(
      client["projects.readFile"]({ cwd: created.workspaceRoot!, relativePath: `${dir}/lldb.txt` }),
      "projects.readFile",
    ).pipe(Effect.catch((cause) => Effect.succeed(describe(cause))));
    const text = typeof transcript === "string" ? "" : transcript.contents;
    yield* record(
      "device.lldb.transcript",
      /stop reason = breakpoint/.test(text) && text.includes(expectedLldb),
      typeof transcript === "string" ? null : transcript.byteLength,
      typeof transcript === "string"
        ? { error: transcript }
        : { stoppedAtBreakpoint: /stop reason = breakpoint/.test(text), tail: text.slice(-800) },
    );
  });

  /** Pauses the box the way archiving does, then wakes it the way reopening a chat does. */
  const resume = Effect.fn("resume")(function* (manager: T3Client) {
    const box = created.box!;
    const access = created.child!;
    const thread = created.threads[0];
    if (!thread) return yield* fail("resume.pause", "no thread to resume");
    const pauseAt = yield* Clock.currentTimeMillis;
    const paused = yield* bounded(
      manager["environmentControl.pause"]({ leaseId: box.leaseId, sandboxId: box.sandboxId }),
      "pause",
    );
    if (paused.kind !== "paused") return yield* fail("resume.pause", paused.kind, paused);
    yield* record("resume.pause", true, seconds(pauseAt, yield* Clock.currentTimeMillis));
    const listed = yield* manager["environmentControl.listProvisioned"]({}).pipe(
      Effect.map((list) => list.find((entry) => entry.leaseId === box.leaseId)),
      Effect.repeat({
        until: (entry) => entry?.lifecycle === "paused",
        schedule: Schedule.spaced("3 seconds"),
      }),
      Effect.timeoutOption(PAUSED_TIMEOUT),
    );
    const lifecycle = Option.getOrUndefined(listed)?.lifecycle ?? "not paused in time";
    yield* record("resume.paused", lifecycle === "paused", lifecycle);

    const pushed = scratch
      ? yield* advanceScratch(scratch).pipe(
          Effect.catch((cause) => fail("refresh.commit", describe(cause))),
        )
      : null;
    if (pushed) yield* record("refresh.commit", true, pushed.sha, { parent: pushed.parent });
    const resumeAt = yield* Clock.currentTimeMillis;
    const resumed = yield* bounded(
      manager["environmentControl.resume"]({ environmentId: box.environmentId }),
      "resume",
    );
    if (resumed.kind !== "resumed") return yield* fail("resume.resumed", resumed.kind, resumed);
    yield* record("resume.resumed", true, seconds(resumeAt, yield* Clock.currentTimeMillis));
    yield* withRpc(access.httpBaseUrl, access.bearer, (client) =>
      Effect.gen(function* () {
        const reconnected = yield* client["server.getConfig"]({}).pipe(
          Effect.retry({ schedule: Schedule.spaced("3 seconds") }),
          Effect.timeoutOption(RECONNECT_TIMEOUT),
        );
        if (Option.isNone(reconnected))
          return yield* fail("resume.reconnect", `child unreachable after ${RECONNECT_TIMEOUT}`);
        yield* record("resume.reconnect", true, seconds(resumeAt, yield* Clock.currentTimeMillis));
        const turn = yield* runTurn(client, thread.agent, "resume.turn", thread);
        if (pushed) {
          yield* record("refresh.head", turn.markers.head === created.head, turn.markers.head, {
            expected: created.head,
            pushed: pushed.sha,
          });
          yield* record("refresh.origin", turn.markers.origin === pushed.sha, turn.markers.origin, {
            expected: pushed.sha,
          });
        }
        if (turn.firstOutputAt !== null)
          yield* record("resume.toFirstOutput", true, seconds(resumeAt, turn.firstOutputAt), {
            from: "resume request",
          });
      }),
    );
  });

  /** Deletes the run's threads, disposes the box twice, and confirms the lease is gone. */

  /** What the automation step created, so its cleanup finds it whichever check failed. */
  const automationCreated: {
    automationId: AutomationId | null;
    runId: string | null;
    requestId: ProvisionRequestId | null;
    environmentId: string | null;
    threadId: ThreadId | null;
  } = { automationId: null, runId: null, requestId: null, environmentId: null, threadId: null };

  /**
   * Proves the automation path end to end: create an automation with a webhook, call the link
   * (twice, as a redelivery), wait for the run's chat to start on its own box, join that box the
   * way a client does, and read the agent's reply.
   */
  const automation = Effect.fn("automation")(function* (manager: T3Client) {
    const agent = options.agents[0]!;
    const { snippet, expectedNonce } = yield* markerSnippet(agent);
    const bodyToken = (yield* uuid).replaceAll("-", "").slice(0, 16);
    const prompt = [
      "Run this exact shell command in the workspace with your shell tool, then reply with the single line it prints, verbatim.",
      'On a second line, print SMOKE_BODY= followed by the value of "smoke" in the webhook request body below. Print nothing else.',
      "",
      snippet,
    ].join("\n");
    const created = yield* bounded(
      manager["automations.create"]({
        name: `smoke ${bodyToken.slice(0, 8)}`,
        repository: options.repo,
        branch: null,
        prompt,
        agentDriver: ProviderDriverKind.make(agent),
        account: null,
        provider: options.provider,
        schedule: null,
        webhook: true,
        enabled: true,
      }),
      "automations.create",
    ).pipe(Effect.catch((cause) => fail("automation.create", describe(cause))));
    automationCreated.automationId = created.automation.id;
    if (created.webhookToken === null)
      return yield* fail("automation.create", "the host minted no webhook link");
    // The link is the whole credential; it never reaches stdout or the report.
    const webhookUrl = new URL(
      `${AUTOMATION_WEBHOOK_PATH_PREFIX}/${created.webhookToken}`,
      options.origin,
    ).toString();
    yield* record("automation.create", true, created.automation.id, {
      agent,
      provider: options.provider,
      repository: options.repo,
      webhookPath: AUTOMATION_WEBHOOK_PATH_PREFIX,
    });

    const deliveryId = yield* uuid;
    const http = yield* HttpClient.HttpClient;
    const deliver = bounded(
      http
        .execute(
          HttpClientRequest.post(webhookUrl).pipe(
            HttpClientRequest.setHeader("idempotency-key", deliveryId),
            HttpClientRequest.bodyJsonUnsafe({ smoke: bodyToken }),
          ),
        )
        .pipe(
          Effect.flatMap((response) =>
            response.json.pipe(
              Effect.flatMap(decodeWebhookAccepted),
              Effect.map((body) => ({ status: response.status, body })),
              Effect.orElseSucceed(() => ({ status: response.status, body: null })),
            ),
          ),
        ),
      "webhook",
    ).pipe(
      Effect.catch((cause) => Effect.succeed({ status: 0, body: null, error: describe(cause) })),
    );

    const first = yield* deliver;
    if (first.status !== 202 || first.body === null)
      return yield* fail(
        "automation.webhook",
        `expected 202 with a run id, got ${first.status}`,
        first,
      );
    automationCreated.runId = first.body.runId;
    yield* record("automation.webhook", true, first.body.runId, {
      status: first.status,
      state: first.body.state,
    });
    // The run's request freezes the default branch's tip on its first provision call, just after.
    const tip = yield* remoteTip("automation.webhook", null);
    const again = yield* deliver;
    yield* record(
      "automation.redelivery",
      again.status === 202 && again.body?.runId === first.body.runId,
      again.body?.runId ?? again.status,
      { status: again.status, expectedRunId: first.body.runId },
    );

    const runId = first.body.runId;
    const triggeredAt = yield* Clock.currentTimeMillis;
    const states: Array<{ readonly at: number; readonly state: string }> = [];
    const settled = yield* Effect.gen(function* () {
      const runs = yield* bounded(
        manager["automations.listRuns"]({ id: created.automation.id, limit: 5 }),
        "automations.listRuns",
      );
      const run = runs.find((candidate) => candidate.id === runId);
      if (run && states.at(-1)?.state !== run.state)
        states.push({ at: seconds(triggeredAt, yield* Clock.currentTimeMillis), state: run.state });
      return run;
    }).pipe(
      Effect.repeat({
        until: (run) =>
          run !== undefined &&
          (run.state === "started" || run.state === "failed" || run.state === "skipped"),
        schedule: Schedule.spaced("5 seconds"),
      }),
      Effect.timeoutOption(AUTOMATION_START_TIMEOUT),
      Effect.catch((cause) => fail("automation.started", describe(cause), { states })),
    );
    if (Option.isNone(settled) || settled.value === undefined)
      return yield* fail("automation.started", `not started after ${AUTOMATION_START_TIMEOUT}`, {
        states,
      });
    const run = settled.value;
    automationCreated.requestId = run.requestId;
    automationCreated.environmentId = run.environmentId;
    automationCreated.threadId = run.threadId;
    if (run.state !== "started" || run.environmentId === null || run.threadId === null)
      return yield* fail("automation.started", `run ${run.state}`, {
        states,
        error: run.error,
        disposedAt: run.disposedAt,
      });
    yield* record(
      "automation.started",
      true,
      seconds(triggeredAt, yield* Clock.currentTimeMillis),
      {
        states,
        requestId: run.requestId,
        environmentId: run.environmentId,
        threadId: run.threadId,
      },
    );

    const joinable = yield* bounded(manager["automations.listJoinable"]({}), "listJoinable").pipe(
      Effect.catch((cause) => fail("automation.joinable", describe(cause))),
    );
    const listed = joinable.find((entry) => entry.requestId === run.requestId);
    if (!listed)
      return yield* fail("automation.joinable", "listJoinable does not include the run", {
        listed: joinable.map((entry) => entry.requestId),
      });
    yield* record("automation.joinable", true, listed.lifecycle, {
      automationId: listed.automationId ?? null,
      threadId: listed.threadId,
    });

    const child = yield* pairChild(manager, "automation.reply", {
      requestId: run.requestId,
      leaseId: listed.leaseId,
      environmentId: run.environmentId,
    });
    const threadId = run.threadId;
    // The runner sent the first user message; the thread's snapshot names it.
    const sent: { message: { readonly id: string; readonly text: string } | null } = {
      message: null,
    };
    let progress = initialProgress;
    const watched = yield* withRpc(child.httpBaseUrl, child.bearer, (client) =>
      client["orchestration.subscribeThread"]({ threadId }).pipe(
        Stream.runForEachWhile((item) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              if (sent.message === null && item.kind === "snapshot") {
                const first = item.snapshot.thread.messages.find(
                  (message) => message.role === "user",
                );
                if (first) sent.message = { id: first.id, text: first.text };
              }
              if (sent.message !== null)
                progress = advanceTurn(progress, item, sent.message.id, now);
              return progress.completedAt === null;
            }),
          ),
        ),
      ),
    ).pipe(
      Effect.timeoutOption(TURN_TIMEOUT),
      Effect.map((finished) => (Option.isSome(finished) ? null : "turn did not finish in time")),
      Effect.catch((cause) => Effect.succeed(describe(cause))),
    );
    const reply = [...progress.assistant.values()].join("\n");
    const markers = readMarkers(reply);
    const head = tip.sha;
    const sentText = sent.message?.text ?? "";
    const evidence = {
      threadId,
      gateway: child.gateway,
      error: progress.error ?? watched,
      expectedNonce,
      expectedHead: head,
      markers,
      body: {
        expected: bodyToken,
        replied: readMarker(reply, "BODY"),
        inPrompt: sentText.includes(bodyToken),
      },
      replyTail: reply.slice(-600),
    };
    const pass =
      progress.error === null &&
      markers.nonce === expectedNonce &&
      markers.head !== null &&
      markers.head === head &&
      evidence.body.inPrompt &&
      evidence.body.replied === bodyToken;
    yield* record("automation.reply", pass, markers.nonce, evidence);
  });

  /**
   * Deletes the automation, then disposes the box of every run it started and checks each lease
   * is gone. Deleting first stops a run still starting; disposing after catches one that already
   * started, whose box outlives its automation. Never fails: it runs after whatever failed.
   */
  const automationCleanup = Effect.fn("automationCleanup")(function* (manager: T3Client) {
    const automationId = automationCreated.automationId;
    if (automationId === null) return;
    const listed = yield* bounded(
      manager["automations.listRuns"]({ id: automationId, limit: 50 }),
      "automations.listRuns",
    ).pipe(Effect.orElseSucceed(() => []));
    const requestIds = new Set(
      listed.filter((run) => run.state !== "skipped").map((run) => run.requestId),
    );
    if (automationCreated.requestId) requestIds.add(automationCreated.requestId);
    const deleted = yield* bounded(
      manager["automations.delete"]({ id: automationId }),
      "automations.delete",
    ).pipe(
      Effect.as(null),
      Effect.catch((cause) => Effect.succeed(describe(cause))),
    );
    const boxes = yield* Effect.forEach([...requestIds], (requestId) =>
      Effect.gen(function* () {
        const disposed = yield* bounded(
          manager["environmentControl.dispose"]({ requestId }),
          "dispose",
        ).pipe(
          Effect.catch((cause) =>
            Effect.succeed({ kind: "error" as const, message: describe(cause) }),
          ),
          Effect.repeat({
            while: (result) => result.kind !== "disposed",
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.timeoutOption(DISPOSE_TIMEOUT),
        );
        const entry = yield* bounded(
          manager["environmentControl.listProvisioned"]({}),
          "list",
        ).pipe(
          Effect.map((list) => list.find((candidate) => candidate.leaseId === requestId)),
          Effect.catch((cause) => Effect.succeed({ lifecycle: `unknown: ${describe(cause)}` })),
        );
        return {
          requestId,
          disposed: Option.isSome(disposed) && disposed.value.kind === "disposed",
          lease: entry?.lifecycle ?? "absent",
        };
      }),
    );
    const pass =
      deleted === null &&
      boxes.every((box) => box.disposed && (box.lease === "absent" || box.lease === "missing"));
    yield* record("automation.cleanup", pass, pass ? boxes.length : "incomplete", {
      deleteError: deleted,
      boxes,
    });
  });

  const remove = Effect.fn("remove")(function* (manager: T3Client) {
    const box = created.box;
    if (!box && !created.requestId) return;
    const access = created.child;
    if (access && created.threads.length > 0) {
      const deleted = yield* withRpc(access.httpBaseUrl, access.bearer, (client) =>
        Effect.forEach(created.threads, (thread) =>
          uuid.pipe(
            Effect.flatMap((commandId) =>
              client["orchestration.dispatchCommand"]({
                type: "thread.delete",
                commandId: CommandId.make(commandId),
                threadId: thread.threadId,
              }),
            ),
            Effect.as(thread.threadId),
          ),
        ),
      ).pipe(
        Effect.timeoutOption("1 minute"),
        Effect.map((result) => (Option.isSome(result) ? null : "no answer in 1m")),
        Effect.catch((cause) => Effect.succeed(describe(cause))),
      );
      yield* record(
        "delete.threads",
        deleted === null,
        deleted === null ? created.threads.length : null,
        { threadIds: created.threads.map((thread) => thread.threadId), error: deleted },
      );
    }
    // Before ready, only the request can be cancelled; after, the web disposes by lease.
    const disposeOnce = bounded(
      manager["environmentControl.dispose"](
        box
          ? { leaseId: box.leaseId, sandboxId: box.sandboxId }
          : { requestId: created.requestId! },
      ),
      "dispose",
    ).pipe(
      Effect.catch((cause) => Effect.succeed({ kind: "error" as const, message: describe(cause) })),
    );
    const disposeAt = yield* Clock.currentTimeMillis;
    let attempts = 0;
    // Another lease operation or a pending cleanup refuses for a moment; the web user would retry.
    const first = yield* disposeOnce.pipe(
      Effect.tap(() => Effect.sync(() => void attempts++)),
      Effect.repeat({
        while: (result) => result.kind !== "disposed",
        schedule: Schedule.spaced("5 seconds"),
      }),
      Effect.timeoutOption(DISPOSE_TIMEOUT),
    );
    const disposed = Option.isSome(first) && first.value.kind === "disposed";
    yield* record(
      "delete.dispose",
      disposed,
      disposed ? seconds(disposeAt, yield* Clock.currentTimeMillis) : "not disposed",
      { attempts, ...(disposed ? {} : { timeout: DISPOSE_TIMEOUT }) },
    );
    if (!box) return;
    const second = yield* disposeOnce;
    yield* record("delete.disposeAgain", second.kind === "disposed", second.kind, second);
    const entry = yield* bounded(manager["environmentControl.listProvisioned"]({}), "list").pipe(
      Effect.map((list) => list.find((candidate) => candidate.leaseId === box.leaseId)),
      Effect.catch((cause) => Effect.succeed({ lifecycle: `unknown: ${describe(cause)}` })),
    );
    yield* record(
      "delete.leaseGone",
      entry === undefined || entry.lifecycle === "missing",
      entry?.lifecycle ?? "absent",
    );
  });

  const bearer = yield* bearerFor().pipe(
    Effect.asSome,
    Effect.catchTag("SmokeFailure", () => Effect.succeed(Option.none<string>())),
    Effect.catch((cause) =>
      record("auth.bearer", false, null, { error: describe(cause) }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );
  if (Option.isSome(bearer)) {
    yield* withRpc(options.origin, bearer.value, (manager) => {
      const steps = Effect.gen(function* () {
        if (!options.steps.has("provision")) return;
        if (scratch) yield* createScratch(scratch);
        const paired = yield* provision(manager);
        yield* turns(manager, paired);
        if (options.steps.has("resume")) yield* resume(manager);
      });
      const automationStep = options.steps.has("automation")
        ? automation(manager).pipe(
            Effect.catchTag("SmokeFailure", () => Effect.void),
            Effect.catch((cause) => record("automation.harness", false, null, describe(cause))),
            Effect.ensuring(automationCleanup(manager).pipe(Effect.ignore)),
          )
        : Effect.void;
      const cleanup = options.steps.has("delete")
        ? remove(manager)
        : Effect.suspend(() =>
            created.box
              ? Console.log(
                  `kept box lease=${created.box.leaseId} sandbox=${created.box.sandboxId}`,
                )
              : Effect.void,
          );
      return steps.pipe(
        Effect.catchTag("SmokeFailure", () => Effect.void),
        Effect.catch((cause) => record("harness", false, null, describe(cause))),
        Effect.ensuring(cleanup),
        Effect.ensuring(
          Effect.suspend(() => (scratch && scratchCreated ? deleteScratch(scratch) : Effect.void)),
        ),
        Effect.andThen(automationStep),
      );
    }).pipe(
      Effect.catch((cause) => record("manager.connect", false, null, { error: describe(cause) })),
    );
  }

  const managerPhases =
    options.managerLog && created.requestId
      ? yield* fs.readFileString(options.managerLog).pipe(
          Effect.map((log) => readManagerPhases(log, created.requestId!)),
          Effect.catch((cause) => Effect.succeed({ error: describe(cause) })),
        )
      : null;
  const ok = checks.length > 0 && checks.every((check) => check.pass);
  const report = yield* encodeReport({
    harness: "smoke-cloud-chat",
    startedAt,
    finishedAt: DateTime.formatIso(yield* DateTime.now),
    origin: options.origin,
    host,
    provider: options.provider,
    agents: options.agents,
    repo: options.repo,
    steps: [...options.steps],
    box: created.box
      ? {
          requestId: created.requestId,
          leaseId: created.box.leaseId,
          sandboxId: created.box.sandboxId,
          environmentId: created.box.environmentId,
        }
      : null,
    automation: automationCreated.automationId ? { ...automationCreated } : null,
    managerPhases,
    ok,
    checks,
  });
  yield* fs.makeDirectory(path.dirname(options.report), { recursive: true });
  yield* fs.writeFileString(options.report, `${report}\n`);
  const width = Math.max(...checks.map((check) => check.name.length));
  yield* Console.log(
    [
      "",
      ...checks.map(
        (check) =>
          `${check.name.padEnd(width)}  ${check.pass ? "PASS" : "FAIL"}  ${check.value ?? ""}`,
      ),
      "",
      `report: ${options.report}`,
    ].join("\n"),
  );
  if (!ok) process.exitCode = 1;
});

const parseList = <const A extends string>(raw: string, allowed: ReadonlyArray<A>, flag: string) =>
  Effect.forEach(raw.split(","), (entry) => {
    const value = entry.trim();
    return (allowed as ReadonlyArray<string>).includes(value)
      ? Effect.succeed(value as A)
      : Effect.fail(
          new SmokeFailure({ message: `--${flag}: ${value} is not one of ${allowed.join(", ")}` }),
        );
  });

const command = Command.make(
  "smoke-cloud-chat",
  {
    origin: Flag.String("origin").pipe(Flag.withDescription("Manager origin, e.g. https://host")),
    pairingTokenFile: Flag.String("pairing-token-file").pipe(
      Flag.withDescription("File holding a manager pairing token; the bearer is cached beside it."),
    ),
    provider: Flag.Literals("provider", ["e2b", "namespace"]).pipe(Flag.withDefault("e2b")),
    agents: Flag.String("agents").pipe(Flag.withDefault("codex,claudeAgent,cursor")),
    repo: Flag.String("repo").pipe(Flag.withDefault("andrewcai8/t3code")),
    steps: Flag.String("steps").pipe(
      Flag.withDescription(
        `Any of ${STEPS.join(", ")}. automation is opt-in and provisions its own box, so it runs alone.`,
      ),
      Flag.withDefault(
        STEPS.filter(
          (step) => step !== "device" && step !== "refresh" && step !== "automation",
        ).join(","),
      ),
    ),
    deviceAgent: Flag.Literals("device-agent", AGENTS).pipe(Flag.withDefault("claudeAgent")),
    managerLog: Flag.String("manager-log").pipe(
      Flag.withDescription(
        "The manager's log, to copy this run's provisioning phases into the report.",
      ),
      Flag.optional,
    ),
    managerState: Flag.String("manager-state").pipe(
      Flag.withDescription(
        "The manager's state directory, to check each agent's account against routing's record.",
      ),
      Flag.optional,
    ),
    report: Flag.String("report").pipe(Flag.withDescription("Where to write the JSON report.")),
  },
  (flags) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const agents = yield* parseList(flags.agents, AGENTS, "agents");
      const steps = new Set(yield* parseList(flags.steps, STEPS, "steps"));
      if (!steps.has("provision") && [...steps].some((step) => step !== "automation"))
        return yield* new SmokeFailure({
          message:
            "--steps: every step but automation runs on a box this run provisions, so include provision",
        });
      if (steps.has("resume") && !steps.has("turns"))
        return yield* new SmokeFailure({
          message: "--steps: resume continues a thread from turns",
        });
      if (steps.has("refresh") && !steps.has("resume"))
        return yield* new SmokeFailure({
          message: "--steps: refresh commits while the box is paused, so include resume",
        });
      if (steps.has("refresh") && steps.has("device"))
        return yield* new SmokeFailure({
          message:
            "--steps: device and refresh each drive the box's workspace; run them in separate smokes",
        });
      if (steps.has("device") && flags.provider !== "namespace")
        return yield* new SmokeFailure({
          message: "--steps: device needs a Namespace Mac; pass --provider namespace",
        });
      yield* smoke({
        origin: new URL(flags.origin).origin,
        pairingTokenFile: path.resolve(flags.pairingTokenFile),
        provider: flags.provider,
        agents,
        repo: flags.repo,
        steps,
        deviceAgent: flags.deviceAgent,
        managerLog: Option.match(flags.managerLog, {
          onNone: () => null,
          onSome: (file) => path.resolve(file),
        }),
        managerState: Option.match(flags.managerState, {
          onNone: () => null,
          onSome: (dir) => path.resolve(dir),
        }),
        report: path.resolve(flags.report),
      });
    }),
).pipe(Command.withDescription("End-to-end smoke for cloud chats against a live T3 manager."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
