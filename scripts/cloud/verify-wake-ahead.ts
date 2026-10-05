/**
 * Live proof for waking cloud chats ahead of the user, against a manager from
 * `scripts/cloud/local-manager.sh`. Each step reads and extends one state file, so steps run
 * separately and `dispose` always finds what earlier steps made.
 *
 *   node scripts/cloud/verify-wake-ahead.ts <step> --origin http://127.0.0.1:PORT \
 *     --pairing-token-file .t3/manager/pairing-token --state /tmp/wake-ahead.json [--count 4] \
 *     [--manager-config .t3/manager/environment-control.json]
 *
 * Steps:
 *   create    provisions `--count` E2B boxes, each with a Claude chat that answered one turn
 *   memory    box 0: teaches the agent a code word, restarts the box's T3 server mid-turn,
 *             wakes the box, and asks for the word back
 *   presence  boxes 1-3: settles box 3's chat, pauses all three, reports the user present, and
 *             times which boxes wake
 *   resume    box 1: pauses it, then times a resume (run after bumping the pinned build)
 *   dispose   deletes every box the state file names
 *
 * Every step appends checks to the state file and prints them; it exits nonzero on a failed one.
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
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProvisionRequestId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { isLoopbackHost } from "@t3tools/shared/preview";
import {
  PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { advanceTurn, initialProgress } from "./turnProgress.ts";

const argument = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
};
const step = process.argv[2] ?? "";
const origin = argument("origin");
const tokenFile = argument("pairing-token-file");
const statePath = argument("state");
const count = Number(argument("count", "4"));
const repo = argument("repo", "andrewcai8/t3code");

const Box = Schema.Struct({
  requestId: Schema.String,
  leaseId: Schema.String,
  sandboxId: Schema.String,
  environmentId: Schema.String,
  httpBaseUrl: Schema.String,
  bearer: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  instanceId: Schema.String,
  model: Schema.String,
});
type Box = typeof Box.Type;
const State = Schema.Struct({
  managerBearer: Schema.optional(Schema.String),
  boxes: Schema.Array(Box),
  checks: Schema.Array(
    Schema.Struct({
      step: Schema.String,
      name: Schema.String,
      pass: Schema.Boolean,
      value: Schema.Unknown,
    }),
  ),
});
type State = typeof State.Type;
const StateJson = Schema.fromJsonString(State);
const decodeState = Schema.decodeUnknownEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);
const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);
const decodeManagerConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ e2bApiKey: Schema.String })),
);
const encodeValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTicket = Schema.decodeUnknownEffect(
  Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket }),
);

const makeClient = RpcClient.make(WsRpcGroup);
type T3Client = typeof makeClient extends Effect.Effect<infer C, infer _E, infer _R> ? C : never;

const wsUrl = (httpBaseUrl: string) => {
  const url = new URL("ws", httpBaseUrl.endsWith("/") ? httpBaseUrl : `${httpBaseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, ORCHESTRATION_PROTOCOL_VERSION_TEXT);
  return url.toString();
};

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
        Effect.flatMap(decodeTicket),
        Effect.map(({ ticket }) => {
          const url = new URL(wsUrl(httpBaseUrl));
          url.searchParams.set("wsTicket", ticket);
          return url.toString();
        }),
        Effect.timeout("1 minute"),
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

const exchange = Effect.fn("exchange")(function* (httpBaseUrl: string, credential: string) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const response = yield* http.execute(
    HttpClientRequest.post(new URL("oauth/token", httpBaseUrl)).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: "wake-ahead proof",
        client_device_type: "bot",
      }),
    ),
  );
  return (yield* decodeAccessToken(yield* response.json)).access_token;
});

const seconds = (from: number, to: number) => Math.round((to - from) / 100) / 10;

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const uuid = (yield* Crypto.Crypto).randomUUIDv4;
  let state: State = (yield* fs.exists(statePath))
    ? yield* decodeState(yield* fs.readFileString(statePath))
    : { boxes: [], checks: [] };
  const save = Effect.gen(function* () {
    yield* fs.writeFileString(statePath, yield* encodeState(state), { mode: 0o600 });
  });
  let failed = false;
  const record = (name: string, pass: boolean, value: unknown) =>
    Effect.gen(function* () {
      failed ||= !pass;
      state = { ...state, checks: [...state.checks, { step, name, pass, value }] };
      yield* save;
      yield* Console.log(`${pass ? "PASS" : "FAIL"} ${step}.${name} ${encodeValue(value)}`);
    });
  if (state.managerBearer === undefined) {
    state = {
      ...state,
      managerBearer: yield* exchange(origin, (yield* fs.readFileString(tokenFile)).trim()),
    };
    yield* save;
  }
  const managerBearer = state.managerBearer!;
  const onManager = <A, E, R>(use: (client: T3Client) => Effect.Effect<A, E, R>) =>
    withRpc(origin, managerBearer, use);
  const onBox = <A, E, R>(box: Box, use: (client: T3Client) => Effect.Effect<A, E, R>) =>
    withRpc(box.httpBaseUrl, box.bearer, use);
  const lifecycle = (box: Box) =>
    onManager((client) =>
      client["environmentControl.listProvisioned"]({}).pipe(
        Effect.map(
          (rows) => rows.find((row) => row.leaseId === box.leaseId)?.lifecycle ?? "absent",
        ),
      ),
    );

  /** Sends one message on a box's chat (starting it when `launch`) and returns the reply. */
  const turn = Effect.fn("turn")(function* (
    box: Box,
    text: string,
    launch: boolean,
    timeout: `${number} minutes` = "8 minutes",
  ) {
    const messageId = MessageId.make(yield* uuid);
    const threadId = ThreadId.make(box.threadId);
    const modelSelection = {
      instanceId: ProviderInstanceId.make(box.instanceId),
      model: box.model,
    };
    return yield* onBox(box, (client) =>
      Effect.gen(function* () {
        yield* launch
          ? client["orchestration.launchThread"]({
              commandId: CommandId.make(yield* uuid),
              creationSource: "web",
              threadId,
              projectId: ProjectId.make(box.projectId),
              title: "wake-ahead proof",
              generateTitle: false,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              workspaceStrategy: { type: "root" },
              initialMessage: { messageId, text, attachments: [] },
            })
          : client["orchestration.dispatchCommand"]({
              type: "message.dispatch",
              commandId: CommandId.make(yield* uuid),
              createdBy: "user",
              creationSource: "web",
              threadId,
              messageId,
              text,
              attachments: [],
              modelSelection,
              deliveryIntent: "auto",
              dispatchMode: { type: "start_immediately" },
            });
        let progress = initialProgress;
        yield* client["orchestration.subscribeThread"]({ threadId }).pipe(
          Stream.runForEachWhile((item) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                progress = advanceTurn(progress, item, messageId, now);
                return progress.completedAt === null && progress.error === null;
              }),
            ),
          ),
          Effect.timeoutOption(timeout),
        );
        return {
          reply: [...progress.assistant.values()].join("\n"),
          error: progress.error,
          notices: (progress.projection?.turnItems ?? []).flatMap((item) =>
            item.type === "system_notice" ? [item.message] : [],
          ),
        };
      }),
    );
  });

  /** Waits until the box answers a config read again, as a client reconnecting does. */
  const reachable = (box: Box) =>
    onBox(box, (client) => client["server.getConfig"]({})).pipe(
      Effect.retry({ schedule: Schedule.spaced("2 seconds") }),
      Effect.timeoutOption("5 minutes"),
      Effect.map(Option.isSome),
    );

  const pauseAll = (boxes: ReadonlyArray<Box>) =>
    Effect.forEach(
      boxes,
      (box) =>
        onManager((client) =>
          client["environmentControl.pause"]({ leaseId: box.leaseId, sandboxId: box.sandboxId }),
        ).pipe(
          Effect.repeat({
            while: (result) => result.kind === "refused",
            schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: "2 minutes" })),
          }),
          Effect.map((result) => result.kind),
        ),
      { concurrency: "unbounded" },
    );

  switch (step) {
    case "create": {
      const config = yield* onManager((client) => client["server.getConfig"]({}));
      const claude = config.providers.find(
        (provider) =>
          provider.driver === "claudeAgent" && provider.enabled && provider.status !== "error",
      );
      if (!claude) return yield* Effect.die("the manager has no usable Claude account");
      const made = yield* Effect.forEach(
        Array.from({ length: count }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const requestId = ProvisionRequestId.make(yield* uuid);
            const started = yield* Clock.currentTimeMillis;
            const ready = yield* onManager((client) =>
              client["environmentControl.provision"]({
                requestId,
                provider: "e2b",
                providerInstanceId: claude.instanceId,
                agentDriver: ProviderDriverKind.make("claudeAgent"),
                repository: repo,
              }).pipe(
                Effect.repeat({
                  while: (result) =>
                    result.kind === "pending" || result.kind === "allocation_unknown",
                  schedule: Schedule.spaced("5 seconds"),
                }),
              ),
            ).pipe(Effect.timeout("20 minutes"));
            if (ready.kind !== "ready")
              return yield* Effect.die(`box ${index} provision ${ready.kind}: ${ready.message}`);
            const environment = ready.environment;
            const attached = yield* onManager((client) =>
              client["environmentControl.attach"]({ requestId }),
            );
            if (attached.kind !== "attached")
              return yield* Effect.die(`attach refused: ${attached.message}`);
            const minted = new URL(attached.pairingUrl);
            const pairingUrl = isLoopbackHost(minted.hostname)
              ? Object.assign(new URL(origin), {
                  pathname: `${PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX}/${encodeURIComponent(environment.leaseId)}/pair`,
                  search: minted.search,
                  hash: minted.hash,
                }).toString()
              : attached.pairingUrl;
            const target = resolveRemotePairingTarget({ pairingUrl });
            const bearer = yield* exchange(target.httpBaseUrl, target.credential);
            const project = yield* withRpc(target.httpBaseUrl, bearer, (client) =>
              client["orchestration.subscribeShell"]({}).pipe(
                Stream.flatMap((item) =>
                  Stream.fromIterable(
                    item.kind === "snapshot"
                      ? item.snapshot.projects
                      : item.kind === "project.updated"
                        ? [item.project]
                        : [],
                  ),
                ),
                Stream.runHead,
                Effect.timeoutOption("2 minutes"),
              ),
            );
            const projectId = Option.flatten(project).pipe(Option.map((found) => found.id));
            if (Option.isNone(projectId)) return yield* Effect.die(`box ${index} lists no project`);
            // The box names its own instances, so the chat runs on the box's Claude.
            const onBoxProvider = yield* withRpc(target.httpBaseUrl, bearer, (client) =>
              client["server.getConfig"]({}).pipe(
                Effect.map((boxConfig) =>
                  boxConfig.providers.find(
                    (provider) =>
                      provider.driver === "claudeAgent" &&
                      provider.enabled &&
                      provider.models.length > 0 &&
                      provider.status !== "error",
                  ),
                ),
                Effect.repeat({
                  until: (provider) => provider !== undefined,
                  schedule: Schedule.spaced("3 seconds").pipe(
                    Schedule.upTo({ duration: "3 minutes" }),
                  ),
                }),
              ),
            );
            if (!onBoxProvider) return yield* Effect.die(`box ${index} has no usable Claude`);
            const model =
              onBoxProvider.models.find((candidate) => /haiku/i.test(candidate.slug)) ??
              onBoxProvider.models.find((candidate) => candidate.isDefault) ??
              onBoxProvider.models[0]!;
            const box: Box = {
              requestId,
              leaseId: environment.leaseId,
              sandboxId: environment.sandboxId,
              environmentId: environment.environmentId,
              httpBaseUrl: target.httpBaseUrl,
              bearer,
              projectId: projectId.value,
              threadId: yield* uuid,
              instanceId: onBoxProvider.instanceId,
              model: model.slug,
            };
            state = { ...state, boxes: [...state.boxes, box] };
            yield* save;
            const claimed = yield* onManager((client) =>
              client["environmentControl.claim"]({
                leaseId: box.leaseId,
                environmentId: environment.environmentId,
                threadId: ThreadId.make(box.threadId),
              }),
            );
            const answered = yield* turn(box, "Reply with the single word READY.", true);
            yield* record(
              `box${index}.ready`,
              claimed.kind === "claimed" && /READY/.test(answered.reply),
              {
                provisionSeconds: seconds(started, yield* Clock.currentTimeMillis),
                claim: claimed.kind,
                reply: answered.reply.slice(0, 80),
              },
            );
            return box;
          }),
        { concurrency: "unbounded" },
      );
      yield* Console.log(`made ${made.length} boxes`);
      break;
    }
    case "memory": {
      // A chat of its own, so earlier runs of this step never shape the agent's answer.
      const box = { ...state.boxes[0]!, threadId: yield* uuid };
      const word = `ORCHID-${(yield* uuid).slice(0, 6).toUpperCase()}`;
      const taught = yield* turn(
        box,
        `We're labelling this work session ${word}. Please keep that label in mind; I'll ask for it later. Reply with just OK.`,
        true,
      );
      yield* record("taught", /OK/i.test(taught.reply), taught.reply.slice(0, 80));
      const serverPid = onBox(box, (client) => client["server.getProcessDiagnostics"]({})).pipe(
        Effect.map((diagnostics) => diagnostics.serverPid),
      );
      const pidBefore = yield* serverPid;
      // The box's T3 server is stopped from outside while the agent's turn still runs, as a crash
      // would stop it. E2B's own shell does it, so the agent has no say.
      const working = yield* turn(
        box,
        "Run `sleep 45` with your shell tool, then reply DONE.",
        false,
        "2 minutes",
      ).pipe(
        Effect.catch((cause) => Effect.succeed({ reply: "", error: String(cause), notices: [] })),
        Effect.forkChild,
      );
      yield* Effect.sleep("12 seconds");
      const { e2bApiKey } = yield* decodeManagerConfig(
        yield* fs.readFileString(argument("manager-config")),
      );
      const killed = yield* spawner.exitCode(
        ChildProcess.make(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import { Sandbox } from "e2b"; const box = await Sandbox.connect(process.argv[1], { apiKey: process.env.E2B_API_KEY }); const ran = await box.commands.run("kill -TERM ${pidBefore}"); process.exit(ran.exitCode);`,
            box.sandboxId,
          ],
          {
            cwd: new URL("../../apps/server/", import.meta.url).pathname,
            env: { E2B_API_KEY: e2bApiKey },
            extendEnv: true,
          },
        ),
      );
      const cut = yield* Fiber.join(working);
      yield* record("serverStopped", killed === 0, {
        pidBefore,
        killExit: killed,
        turnError: cut.error,
      });
      const resumeAt = yield* Clock.currentTimeMillis;
      const resumed = yield* onManager((client) =>
        client["environmentControl.resume"]({
          environmentId: EnvironmentId.make(box.environmentId),
        }),
      ).pipe(
        Effect.repeat({
          while: (result) => result.kind !== "resumed",
          schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: "5 minutes" })),
        }),
      );
      yield* record("restarted", resumed.kind === "resumed", {
        seconds: seconds(resumeAt, yield* Clock.currentTimeMillis),
      });
      yield* record("reachable", yield* reachable(box), null);
      const pidAfter = yield* serverPid;
      yield* record("serverRestarted", pidAfter !== pidBefore, { pidBefore, pidAfter });
      const recalled = yield* turn(
        box,
        "What label did I give this work session at the start of our conversation? Reply with just the label.",
        false,
      );
      yield* record("recalled", recalled.reply.includes(word), {
        expected: word,
        reply: recalled.reply.slice(0, 120),
        notices: recalled.notices,
      });
      break;
    }
    case "presence": {
      const [first, second, settled] = state.boxes.slice(1, 4);
      if (!first || !second || !settled) return yield* Effect.die("presence needs boxes 1-3");
      const settleId = CommandId.make(yield* uuid);
      yield* onBox(settled, (client) =>
        client["orchestration.dispatchCommand"]({
          type: "thread.settle",
          commandId: settleId,
          threadId: ThreadId.make(settled.threadId),
        }),
      );
      const paused = yield* pauseAll([first, second, settled]);
      yield* record(
        "paused",
        paused.every((kind) => kind === "paused"),
        paused,
      );
      const reportedAt = yield* Clock.currentTimeMillis;
      const answer = yield* onManager((client) =>
        client["environmentControl.presence"]({ present: true }),
      );
      yield* record(
        "answer",
        [first, second].every((box) =>
          answer.machines.some(
            (machine) => machine.environmentId === box.environmentId && machine.state === "waking",
          ),
        ) &&
          answer.machines.some(
            (machine) =>
              machine.environmentId === settled.environmentId && machine.state === "asleep",
          ),
        answer.machines,
      );
      const awake = yield* Effect.forEach(
        [first, second],
        (box) =>
          lifecycle(box).pipe(
            Effect.repeat({
              until: (current) => current === "active",
              schedule: Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "3 minutes" })),
            }),
            Effect.flatMap((current) =>
              Clock.currentTimeMillis.pipe(
                Effect.map((now) => ({ current, seconds: seconds(reportedAt, now) })),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      );
      yield* record(
        "unsettledWoke",
        awake.every((box) => box.current === "active"),
        awake,
      );
      const connected = yield* Effect.forEach([first, second], reachable, {
        concurrency: "unbounded",
      });
      yield* record("unsettledConnect", connected.every(Boolean), {
        seconds: seconds(reportedAt, yield* Clock.currentTimeMillis),
      });
      yield* Effect.sleep("45 seconds");
      yield* record(
        "settledSlept",
        (yield* lifecycle(settled)) === "paused",
        yield* lifecycle(settled),
      );
      break;
    }
    case "resume": {
      const box = state.boxes[1]!;
      const paused = yield* pauseAll([box]);
      yield* record("paused", paused[0] === "paused", paused);
      const resumeAt = yield* Clock.currentTimeMillis;
      const resumed = yield* onManager((client) =>
        client["environmentControl.resume"]({
          environmentId: EnvironmentId.make(box.environmentId),
        }),
      );
      const answeredAt = yield* Clock.currentTimeMillis;
      const connected = yield* reachable(box);
      yield* record("resumed", resumed.kind === "resumed", {
        resumeSeconds: seconds(resumeAt, answeredAt),
        connectSeconds: seconds(resumeAt, yield* Clock.currentTimeMillis),
        connected,
      });
      break;
    }
    case "dispose": {
      // Only boxes this script made: the manager may be a live host whose other boxes are real chats.
      const leases = new Map(
        state.boxes.map((box) => [box.leaseId, { leaseId: box.leaseId, sandboxId: box.sandboxId }]),
      );
      const results = yield* Effect.forEach(
        [...leases.values()],
        (box) =>
          onManager((client) =>
            client["environmentControl.dispose"]({
              leaseId: box.leaseId,
              sandboxId: box.sandboxId,
            }),
          ).pipe(
            Effect.repeat({
              while: (result) => result.kind !== "disposed",
              schedule: Schedule.spaced("5 seconds").pipe(Schedule.upTo({ duration: "3 minutes" })),
            }),
            Effect.map((result) => result.kind),
          ),
        { concurrency: "unbounded" },
      );
      yield* record(
        "disposed",
        results.every((kind) => kind === "disposed"),
        results,
      );
      // A request that became ready without a lease is only reachable by its id.
      const requests = argument("requests", "")
        .split(",")
        .filter((id) => id !== "");
      const cancelled = yield* Effect.forEach(requests, (requestId) =>
        onManager((client) =>
          client["environmentControl.dispose"]({ requestId: ProvisionRequestId.make(requestId) }),
        ).pipe(Effect.map((result) => result.kind)),
      );
      if (requests.length > 0)
        yield* record(
          "requestsCancelled",
          cancelled.every((kind) => kind === "disposed"),
          cancelled,
        );
      break;
    }
    default:
      return yield* Effect.die(`unknown step ${step}`);
  }
  if (failed) return yield* Effect.die("a check failed");
});

program.pipe(
  Effect.provide(Layer.merge(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
