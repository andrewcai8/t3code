/**
 * End to end for Namespace Mac chats on the instance engine, against a manager whose repository
 * entry sets `namespace.engine: "instance"` (scripts/cloud/local-manager.sh with the engine set in
 * its copied config). Every chat starts from a first turn the host sends after its caller left.
 *
 *   node apps/server/scripts/mac-chat-e2e.ts --origin http://127.0.0.1:PORT \
 *     --pairing-token-file .t3/manager/pairing-token --manager-state .t3/manager/userdata \
 *     --manager-log .t3/manager/manager.log --repo andrewcai8/t3code --report /tmp/mac-e2e.json
 *
 * Runs, in order: a new chat on a cache miss, the builder Mac it asks for committing a template,
 * release while idle, a new chat on a hit, resume onto a new Mac with its worktree, checkpoints,
 * transcripts and environment id compared byte for byte, a Mac destroyed out of band that comes
 * back from its last periodic save, and dispose. Then it checks that no Mac, builder, snapshot or
 * chat record is left and releases the cache volume. Tokens and pairing URLs never reach stdout or
 * the report.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off cryptoRandomUUID:off globalConsole:off globalTimers:off - an operator lever that drives a live manager and Namespace, reporting as it goes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { createClient, createGlobalTransport } from "@namespacelabs/sdk/api";
import { createComputeClient } from "@namespacelabs/sdk/api/compute";
import { loadDefaults } from "@namespacelabs/sdk/auth";
import { ArtifactsService } from "@namespacelabs/sdk/proto/namespace/cloud/storage/v1beta/artifact_pb";
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  AuthWebSocketTicketResult,
  defaultInstanceIdForDriver,
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProvisionRequestId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import {
  PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import { canonicalRepository } from "../src/environmentControl/config.ts";
import { DERIVED_HOME_PATHS } from "../src/environmentControl/guestChatState.ts";
import { ChatRecord } from "../src/environmentControl/namespaceChat.ts";
import {
  makeNamespaceArtifacts,
  makeNamespaceInstances,
  spawnNsc,
  type InstanceId,
} from "../src/environmentControl/namespaceInstances.ts";

const { values: flags } = NodeUtil.parseArgs({
  options: {
    origin: { type: "string" },
    "pairing-token-file": { type: "string" },
    "manager-state": { type: "string" },
    "manager-log": { type: "string" },
    repo: { type: "string", default: "andrewcai8/t3code" },
    report: { type: "string" },
    /** Leaves out the out-of-band destroy, which needs a periodic save first. */
    "skip-kill": { type: "boolean", default: false },
  },
});
const required = (name: keyof typeof flags) => {
  const value = flags[name];
  if (typeof value !== "string") throw new Error(`--${name} is required`);
  return value;
};
const origin = new URL(required("origin")).origin;
const managerState = NodePath.resolve(required("manager-state"));
const managerLog = NodePath.resolve(required("manager-log"));
const repo = required("repo");
const reportPath = NodePath.resolve(required("report"));

const ROOT = "/Volumes/t3/root";
const started = Date.now();
const elapsed = (from = started) => Math.round((Date.now() - from) / 100) / 10;
const checks: Array<{ name: string; pass: boolean; value: unknown; evidence?: unknown }> = [];
const measured: Record<string, unknown> = {};
const check = (name: string, pass: boolean, value: unknown, evidence?: unknown) => {
  checks.push({ name, pass, value, ...(evidence === undefined ? {} : { evidence }) });
  console.log(`[${elapsed()}s] ${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(value)}`);
};
const measure = (name: string, value: unknown) => {
  measured[name] = value;
  console.log(`[${elapsed()}s] ${name} ${JSON.stringify(value)}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<A>(what: string, timeoutMs: number, probe: () => Promise<A | null>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe().catch(() => null);
    if (found !== null) return found;
    if (Date.now() > deadline) throw new Error(`${what}: not reached in ${timeoutMs / 1000}s`);
    await sleep(5_000);
  }
}

const decodeAccessToken = Schema.decodeUnknownEffect(AuthAccessTokenResult);
const decodeTicket = Schema.decodeUnknownEffect(
  Schema.Struct({ ticket: AuthWebSocketTicketResult.fields.ticket }),
);
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ChatRecord));
const makeClient = RpcClient.make(WsRpcGroup);
type T3Client = typeof makeClient extends Effect.Effect<infer C, infer _E, infer _R> ? C : never;
const layers = Layer.mergeAll(FetchHttpClient.layer);

const exchange = (httpBaseUrl: string, credential: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const response = yield* http.execute(
        HttpClientRequest.post(new URL("oauth/token", httpBaseUrl)).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: AuthTokenExchangeGrantType,
            subject_token: credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            client_label: "mac chat e2e",
            client_device_type: "bot",
          }),
        ),
      );
      return (yield* decodeAccessToken(yield* response.json)).access_token;
    }).pipe(Effect.provide(layers)),
  );

/** One RPC session; every connection authenticates with a fresh ticket in its URL. */
const rpc = <A, E>(
  httpBaseUrl: string,
  bearer: string,
  use: (client: T3Client) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const wsUrl = new URL("ws", httpBaseUrl.endsWith("/") ? httpBaseUrl : `${httpBaseUrl}/`);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
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
            wsUrl.searchParams.set("wsTicket", ticket);
            return wsUrl.toString();
          }),
          // Without a ticket the server refuses the upgrade, and the call reports that.
          Effect.orElseSucceed(() => wsUrl.toString()),
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
    }).pipe(Effect.provide(layers)),
  );

const tokenSource = await loadDefaults();
const namespace = makeNamespaceInstances({
  compute: createComputeClient({ tokenSource, region: "us" }).compute,
  nsc: spawnNsc(),
});
const { storage } = createComputeClient({ tokenSource, region: "us" });
const artifacts = makeNamespaceArtifacts({
  artifacts: createClient(
    ArtifactsService,
    createGlobalTransport({ tokenSource, baseUrl: "https://ord.storage.namespaceapis.com" }),
  ),
});
const cacheTag = `t3-mac-${NodeCrypto.createHash("sha256")
  .update(canonicalRepository(repo))
  .digest("hex")
  .slice(0, 12)}-v1`;

const managerBearer = await exchange(
  origin,
  (await NodeFSP.readFile(required("pairing-token-file"), "utf8")).trim(),
);
const manager = <A, E>(use: (client: T3Client) => Effect.Effect<A, E>) =>
  rpc(origin, managerBearer, use);

const config = await manager((client) => client["server.getConfig"]({}));
/** The first turn names its instance, so the chat is pinned to the codex account with most room. */
const mostUsed = (provider: (typeof config.providers)[number]) =>
  provider.usageLimits?.windows.length
    ? Math.max(...provider.usageLimits.windows.map((window) => window.usedPercent))
    : 50;
const codex = (() => {
  const found = config.providers
    .filter(
      (provider) => provider.driver === "codex" && provider.enabled && provider.models.length > 0,
    )
    .toSorted((a, b) => mostUsed(a) - mostUsed(b))[0];
  if (!found) throw new Error("the manager has no enabled codex account");
  return found;
})();
const model =
  codex.models.find((candidate) => /mini|luna/i.test(candidate.slug)) ??
  codex.models.find((candidate) => candidate.isDefault) ??
  codex.models[0];
if (!model) throw new Error("the codex account lists no models");
// A box names each agent's instance by its driver, whichever account routing gave it.
const modelSelection = {
  instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
  model: model.slug,
};

interface Chat {
  readonly label: string;
  readonly requestId: ProvisionRequestId;
  readonly threadId: ThreadId;
  environmentId: string;
  leaseId: string;
  sandboxId: string;
}
const chats: Chat[] = [];

const recordOf = async (chat: Chat) => {
  const text = await NodeFSP.readFile(
    NodePath.join(managerState, "namespace-chats", `${chat.requestId}.json`),
    "utf8",
  ).catch(() => null);
  return text === null ? null : decodeRecord(text);
};
const liveMac = async (chat: Chat) => {
  const record = await recordOf(chat);
  if (record?.kind !== "live") throw new Error(`${chat.label} has no live Mac`);
  return record.mac.incarnation;
};
const listed = (chat: Chat) =>
  manager((client) => client["environmentControl.listProvisioned"]({})).then(
    (environments) =>
      environments.find((environment) => environment.requestId === chat.requestId) ?? null,
  );
/** The manager log's entries for a message, with the fields Effect's logger prints under them. */
const logEntries = async (message: string) => {
  const log = await NodeFSP.readFile(managerLog, "utf8");
  const found: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of log.split("\n")) {
    if (line.includes(`: ${message}`)) {
      current = {};
      found.push(current);
      continue;
    }
    const field = current ? line.match(/^ {2}(\w+): (.*)$/) : null;
    if (current && field) current[field[1]!] = field[2]!;
    else current = null;
  }
  return found;
};
const logLines = async (chat: Chat, message: string) =>
  (await logEntries(message)).filter(
    (entry) => entry.chatId === chat.requestId || entry.requestId === chat.requestId,
  );
/** This repository's finished template builds, oldest first. */
const builds = async () =>
  (await logEntries("namespace mac template build")).filter((entry) => entry.tag === cacheTag);
const guest = async (instanceId: InstanceId, script: string) => {
  const result = await namespace.exec(instanceId, ["bash", "-c", script], { timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`guest script failed: ${result.stderr.slice(-400)}`);
  return result.stdout.trim();
};
/** What a resume must reproduce, as git and content hashes read on the Mac. */
const survivors = (instanceId: InstanceId) =>
  guest(
    instanceId,
    String.raw`
set -euo pipefail
cd ${ROOT}/workspace
echo "environment $(cat ${ROOT}/home/.t3/userdata/environment-id)"
echo "head $(git symbolic-ref -q HEAD) $(git rev-parse HEAD)"
git status --porcelain=v1 --untracked-files=all | sort
git for-each-ref --format='%(refname) %(objectname)' refs/heads refs/t3 | sort
git stash list --format='%H %gs'
shasum -a 256 e2e-*.txt 2>/dev/null || true
cd ${ROOT}/home
{ find .codex/sessions .claude/projects -type f 2>/dev/null || true; } | sort | while read -r f; do shasum -a 256 "$f"; done
`,
  );

/** Provisions a chat whose first turn the host starts, abandoning the request after 5 seconds. */
async function provisionDetached(label: string) {
  const chat: Chat = {
    label,
    requestId: ProvisionRequestId.make(NodeCrypto.randomUUID()),
    threadId: ThreadId.make(NodeCrypto.randomUUID()),
    environmentId: "",
    leaseId: "",
    sandboxId: "",
  };
  chats.push(chat);
  const asked = Date.now();
  await manager((client) =>
    client["environmentControl.provision"]({
      requestId: chat.requestId,
      provider: "namespace",
      providerInstanceId: codex.instanceId,
      pinAccount: true,
      agentDriver: ProviderDriverKind.make("codex"),
      repository: repo,
      chat: {
        threadId: chat.threadId,
        firstTurn: {
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text: `Create a file named e2e-agent.txt in the repository root containing exactly AGENT_${label.toUpperCase()} and nothing else. Do not commit it. Then reply with the single word PINEAPPLE.`,
          title: `mac e2e ${label}`,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
      },
    }).pipe(Effect.timeoutOption("5 seconds")),
  );
  check(`${label}.caller.detached`, true, "provision request abandoned after 5s");
  const environment = await until(`${label} ready`, 25 * 60_000, async () => {
    const found = await listed(chat);
    return found?.lifecycle === "active" ? found : null;
  });
  chat.environmentId = environment.environmentId;
  chat.leaseId = environment.leaseId;
  chat.sandboxId = environment.sandboxId;
  measure(`${label}.readySeconds`, elapsed(asked));
  check(`${label}.owner`, environment.threadId === chat.threadId, environment.threadId);
  const phases = await logLines(chat, "provision phase");
  measure(
    `${label}.phases`,
    phases.map((phase) => `${phase.phase}=${Math.round(Number(phase.durationMs) / 100) / 10}s`),
  );
  return { chat, asked };
}

/** Pairs a client with the chat's box after the fact and reads the host-started turn. */
async function firstTurn(chat: Chat, asked: number) {
  const attached = await manager((client) =>
    client["environmentControl.attach"]({ requestId: chat.requestId }),
  );
  if (attached.kind !== "attached") throw new Error(`${chat.label}: attach refused`);
  const minted = new URL(attached.pairingUrl);
  const pairingUrl = Object.assign(new URL(origin), {
    pathname: `${PROVISIONED_ENVIRONMENT_GATEWAY_PREFIX}/${encodeURIComponent(chat.leaseId)}/pair`,
    search: minted.search,
    hash: minted.hash,
  }).toString();
  const target = resolveRemotePairingTarget({
    pairingUrl: ["127.0.0.1", "localhost"].includes(minted.hostname)
      ? pairingUrl
      : attached.pairingUrl,
  });
  const bearer = await exchange(target.httpBaseUrl, target.credential);
  let seen: unknown = "no snapshot";
  let shown = "";
  const thread = await until(`${chat.label} turn`, 10 * 60_000, async () => {
    const snapshot = await rpc(target.httpBaseUrl, bearer, (client) =>
      client["orchestration.subscribeThread"]({ threadId: chat.threadId }).pipe(Stream.runHead),
    ).catch((error: unknown) => {
      seen = String(error);
      return Option.none();
    });
    if (Option.isNone(snapshot) || snapshot.value.kind !== "snapshot") return null;
    const current = snapshot.value.snapshot.thread;
    seen = {
      messages: current.messages.map((message) => message.role),
      turn: current.latestTurn?.state ?? null,
      session: current.session?.status ?? null,
      error: current.session?.lastError ?? null,
    };
    const summary = JSON.stringify(seen);
    if (summary !== shown) console.log(`[${elapsed()}s] ${chat.label} thread ${(shown = summary)}`);
    const settled = current.latestTurn !== null && current.latestTurn.state !== "running";
    return settled || current.session?.status === "error" ? current : null;
  }).catch((error: unknown) => {
    throw new Error(`${String(error)}; last seen ${JSON.stringify(seen)}`);
  });
  const reply = thread.messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .join("\n");
  measure(`${chat.label}.firstTurnSeconds`, elapsed(asked));
  check(
    `${chat.label}.firstTurn`,
    thread.messages.filter((message) => message.role === "user").length === 1 &&
      /PINEAPPLE/.test(reply),
    { turn: thread.latestTurn?.state, reply: reply.slice(-80) },
  );
}

/** Each version of the cache volume by the Mac that held it: 1 in use, 2 committed, 4 abandoned. */
async function cacheVersions() {
  const volumes = await storage.listCacheVolumes({});
  return volumes.cacheVolume
    .filter((volume) => volume.tag === cacheTag)
    .map((volume) => ({
      instanceId: volume.attachment?.attachedTo ?? "",
      state: Number(volume.metadata?.state),
    }));
}
const stateOf = async (instanceId: string) =>
  (await cacheVersions()).find((version) => version.instanceId === instanceId)?.state ?? null;

const report = async (failure?: unknown) => {
  await NodeFSP.writeFile(
    reportPath,
    JSON.stringify(
      {
        startedAt: new Date(started).toISOString(),
        cacheTag,
        measured,
        checks,
        ...(failure === undefined ? {} : { failure: String(failure) }),
      },
      null,
      2,
    ),
  );
};

let failure: unknown;
try {
  check("cache.emptyAtStart", (await cacheVersions()).length === 0, cacheTag);

  const a = await provisionDetached("miss");
  const filler = await liveMac(a.chat);
  measure("miss.site", filler.site);
  const missAdoption = (await logLines(a.chat, "namespace mac materialized")).at(-1)?.adoption;
  check("miss.adoption", missAdoption === "miss", missAdoption);
  await firstTurn(a.chat, a.asked);
  await guest(
    filler.instanceId,
    `cd ${ROOT}/workspace && echo staged > e2e-staged.txt && git add e2e-staged.txt && echo untracked > e2e-untracked.txt && printf 'edit\\n' >> README.md`,
  );
  const before = await survivors(filler.instanceId);
  const derived = [...DERIVED_HOME_PATHS, ".t3/worktrees", ".t3/megpt-ios-baseline.tar.gz"];
  const kept = (
    await guest(
      filler.instanceId,
      `cd ${ROOT}/home && du -sk .[!.]*/* .[!.]*/*/* */* 2>/dev/null | sort -rn | head -60`,
    )
  )
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([, path]) =>
        path !== undefined &&
        !derived.some(
          (entry) => path === entry || path.startsWith(`${entry}/`) || entry.startsWith(`${path}/`),
        ),
    )
    .slice(0, 10)
    .map(([kb, path]) => `${path}=${Math.round(Number(kb) / 1024)}MB`);
  measure("snapshot.largestKeptHome", kept);
  measure(
    "snapshot.homeKb",
    (
      await guest(
        filler.instanceId,
        `cd ${ROOT}/home && du -sk .[!.]* .[!.]*/* * 2>/dev/null | sort -n | tail -12 | tr '\\t' ' '`,
      )
    ).split("\n"),
  );

  const build = await until(
    "the template build",
    30 * 60_000,
    async () => (await builds())[0] ?? null,
  );
  measure("builder", {
    site: build.site,
    adoption: build.adoption,
    departure: build.departure,
    minutes: Math.round(Number(build.durationMs) / 6_000) / 10,
    sameSiteAsMiss: build.site === filler.site,
  });
  check("builder.commits", build.departure === "commit", build.instanceId);
  const builderState = await until("the builder's version at rest", 180_000, async () =>
    (await stateOf(build.instanceId ?? "")) === 2 ? 2 : null,
  );
  check("builder.atRest", builderState === 2, builderState);

  const pausing = Date.now();
  const paused = await manager((client) =>
    client["environmentControl.pause"]({ leaseId: a.chat.leaseId, sandboxId: a.chat.sandboxId }),
  );
  measure("release.seconds", elapsed(pausing));
  const released = await recordOf(a.chat);
  check("release.paused", paused.kind === "paused", paused.kind);
  check(
    "release.snapshot",
    released?.kind === "idle" && released.snapshot?.mode === "final",
    released?.snapshot
      ? { generation: released.snapshot.generation, bytes: released.snapshot.bytes }
      : null,
  );
  const missState = await until("the miss chat's version settled", 180_000, async () => {
    const state = await stateOf(filler.instanceId);
    return state === null || state === 1 ? null : state;
  });
  check("release.chatAbandons", missState === 4, missState);

  const b = await provisionDetached("hit");
  const hitAdoption = (await logLines(b.chat, "namespace mac materialized")).at(-1)?.adoption;
  const hitSite = (await liveMac(b.chat)).site;
  measure("hit.site", hitSite);
  // Namespace places a Mac in a site of its choosing; only the builder's site holds the template.
  check("hit.adoption", hitAdoption === "hit", { adoption: hitAdoption, builderSite: build.site });
  await firstTurn(b.chat, b.asked);
  const disposingB = Date.now();
  const disposedB = await manager((client) =>
    client["environmentControl.dispose"]({ requestId: b.chat.requestId }),
  );
  measure("dispose.hitSeconds", elapsed(disposingB));
  check("dispose.hit", disposedB.kind === "disposed", disposedB.kind);

  const resuming = Date.now();
  const resumed = await manager((client) =>
    client["environmentControl.resume"]({
      environmentId: EnvironmentId.make(a.chat.environmentId),
    }),
  );
  measure("resume.seconds", elapsed(resuming));
  check("resume.resumed", resumed.kind === "resumed", resumed.kind);
  const second = await liveMac(a.chat);
  measure("resume.site", second.site);
  measure(
    "resume.adoption",
    (await logLines(a.chat, "namespace mac materialized")).at(-1)?.adoption,
  );
  const after = await survivors(second.instanceId);
  check("resume.survivors", after === before, after === before ? "identical" : "differ", {
    before: before.split("\n"),
    after: after.split("\n"),
  });

  if (!flags["skip-kill"]) {
    await guest(second.instanceId, `cd ${ROOT}/workspace && echo periodic > e2e-periodic.txt`);
    // A watching client's heartbeat, so the idle reaper leaves the chat alone while upkeep saves it.
    await manager((client) => client["environmentControl.touch"]({ leaseId: a.chat.leaseId }));
    const generation = (await recordOf(a.chat))?.snapshot?.generation ?? 0;
    const waiting = Date.now();
    const saved = await until("a periodic save", 8 * 60_000, async () => {
      const record = await recordOf(a.chat);
      return record?.snapshot &&
        record.snapshot.generation > generation &&
        record.snapshot.mode === "live"
        ? record.snapshot
        : null;
    });
    measure("periodicSave.waitSeconds", elapsed(waiting));
    measure("periodicSave.bytes", saved.bytes);
    await guest(second.instanceId, `cd ${ROOT}/workspace && echo lost > e2e-lost.txt`);
    const killedAt = Date.now();
    const destroyed = await spawnNsc().run(["destroy", "--force", second.instanceId], {
      timeoutMs: 120_000,
    });
    check("kill.outOfBand", destroyed.exitCode === 0, second.instanceId);
    const touched = await manager((client) =>
      client["environmentControl.touch"]({ leaseId: a.chat.leaseId }),
    );
    check(
      "kill.touchPauses",
      touched.kind === "refused" && (await listed(a.chat))?.lifecycle === "paused",
      touched,
    );
    const recovering = Date.now();
    const recovered = await manager((client) =>
      client["environmentControl.resume"]({
        environmentId: EnvironmentId.make(a.chat.environmentId),
      }),
    );
    measure("kill.resumeSeconds", elapsed(recovering));
    measure("kill.recoveredSeconds", elapsed(killedAt));
    check("kill.resumed", recovered.kind === "resumed", recovered.kind);
    const third = await liveMac(a.chat);
    measure("kill.site", third.site);
    measure(
      "kill.adoption",
      (await logLines(a.chat, "namespace mac materialized")).at(-1)?.adoption,
    );
    const files = await guest(
      third.instanceId,
      `cd ${ROOT}/workspace && ls e2e-*.txt && cat ${ROOT}/home/.t3/userdata/environment-id`,
    );
    check(
      "kill.lastPeriodicSave",
      files.includes("e2e-periodic.txt") && !files.includes("e2e-lost.txt"),
      files.split("\n"),
    );
    check("kill.environmentId", files.endsWith(a.chat.environmentId), a.chat.environmentId);
  }

  const disposingA = Date.now();
  const disposedA = await manager((client) =>
    client["environmentControl.dispose"]({ requestId: a.chat.requestId }),
  );
  measure("dispose.resumedSeconds", elapsed(disposingA));
  check("dispose.resumed", disposedA.kind === "disposed", disposedA.kind);
} catch (error) {
  failure = error;
  console.log(`[${elapsed()}s] FAIL ${String(error)}`);
} finally {
  for (const chat of chats) {
    const disposed = await manager((client) =>
      client["environmentControl.dispose"]({ requestId: chat.requestId }),
    ).catch((error: unknown) => String(error));
    const instances = await namespace.list({ "t3.chat": chat.requestId });
    for (const { instanceId } of instances) await namespace.depart(instanceId, "abandon");
    const left = await artifacts.list({ "t3.chat": chat.requestId });
    for (const { path } of left) await artifacts.expire(path);
    check(
      `cleanup.${chat.label}`,
      instances.length === 0 && left.length === 0 && (await recordOf(chat)) === null,
      { disposed, instances: instances.length, artifacts: left.length },
    );
  }
  // A miss on a later chat may have started another build; this run owns the tag, so stop it.
  const builders = await namespace.list({ "t3.builder": cacheTag });
  for (const { instanceId } of builders) await namespace.depart(instanceId, "abandon");
  measure("cleanup.buildersAbandoned", builders.length);
  measure("builds", await builds().catch(() => []));
  await sleep(30_000);
  await storage.destroyCacheVolume({ tag: cacheTag }).catch(() => undefined);
  check("cleanup.cacheVolume", (await cacheVersions()).length === 0, cacheTag);
  measure("totalSeconds", elapsed());
  await report(failure);
}
process.exit(failure === undefined && checks.every((entry) => entry.pass) ? 0 : 1);
