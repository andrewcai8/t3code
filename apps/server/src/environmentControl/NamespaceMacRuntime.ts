// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - names snapshot uploads and runtime staging paths on the Mac.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { createClient, createRegionTransport } from "@namespacelabs/sdk/api";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import type { ProvisionOperation } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { canonicalRepository, type ProvisionRuntimeArtifact } from "./config.ts";
import {
  adoptChatTemplate,
  restoreChat,
  saveChat,
  scrubChatRoot,
  sealChatTemplate,
} from "./guestChatState.ts";
import { guestToolInstallCommand, withGuestProviderInstall } from "./guestProviderInstall.ts";
import {
  drive,
  periodicSave,
  settle,
  type ChatPerformer,
  type ChatPorts,
  type ChatRecord,
} from "./namespaceChat.ts";
import { makeChatStore } from "./namespaceChatStore.ts";
import {
  makeNamespaceArtifacts,
  makeNamespaceInstances,
  nscWithToken,
  type Departure,
  type InstanceId,
  type NamespaceArtifacts,
  type NamespaceInstances,
} from "./namespaceInstances.ts";
import {
  makeNamespacePublisher,
  mintNamespacePairing,
  resolveNamespaceArtifactSources,
  type NamespaceAccountSession,
} from "./NamespaceProvisionRuntime.ts";
import { ProvisionedSandboxMissing } from "./driver.ts";
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import {
  desiredRuntime,
  followedBranch,
  frozenMacTemplate,
  provisionDigest,
  type MacTemplateIdentity,
  type ProvisionPreparationManifest,
} from "./ProvisionPreparation.ts";
import { startProvisionPhase, type RecordProvisionPhase } from "./provisionTiming.ts";
import {
  prepareRemoteHost,
  type RemotePreparationPort,
  type RemotePreparationReady,
} from "./remotePreparation.ts";

/** Namespace destroys an instance at creation + 5h; asking for less leaves room to release first. */
const MAC_LIFETIME_MS = 5 * 3_600_000 - 5 * 60_000;
/** A released chat keeps its snapshot this long. */
const SNAPSHOT_RETENTION_MS = 90 * 86_400_000;
/** Larger than any chat's own state; past it a save is probably carrying a cache. */
const SNAPSHOT_MAX_BYTES = 4 * 1024 ** 3;
const CACHE_VOLUME_GB = 100;
/** A template older than this is still adopted, and a builder refreshes it. */
const TEMPLATE_MAX_AGE_SECONDS = 12 * 3_600;
/** Ample for a builder's prepare and seal; bounds what a manager crash mid-build leaves running. */
const BUILDER_LIFETIME_MS = 60 * 60_000;
/** Builds a repository may start in an hour, and the backoff after a failed one, doubling. */
const BUILDS_PER_HOUR = 3;
const BUILD_BACKOFF_MS = 5 * 60_000;
const BUILD_BACKOFF_MAX_MS = 2 * 3_600_000;
/** Inside this much of its deadline an idle Mac is released; inside the second, a busy one too. */
const ROTATE_IDLE_MS = 30 * 60_000;
const ROTATE_FORCE_MS = 8 * 60_000;
/** A chat's periodic saves, which bound the work an unplanned Mac death loses. */
const SAVE_INTERVAL_MS = 5 * 60_000;

/**
 * Runs a script with the qualified Xcode when the image has one, like the
 * Devbox port, but over `nsc ssh` with stdin, which instances forward.
 */
const runWithXcode = String.raw`
import os,pathlib,re,sys
xcodes=[]
for app in pathlib.Path('/Applications').glob('Xcode_26.4*.app'):
    match=re.fullmatch(r'Xcode_(26\.4(?:\.\d+)?)\.app',app.name)
    developer=app/'Contents/Developer'
    if match and (developer/'Library/PrivateFrameworks/SimulatorKit.framework').is_dir():
        xcodes.append((tuple(map(int,match.group(1).split('.'))),developer))
if xcodes:
    os.environ['DEVELOPER_DIR']=str(max(xcodes)[1])
os.execv(sys.executable,[sys.executable,'-c',sys.argv[1]])
`;

const stageRuntimeScript = String.raw`
import hashlib,os,pathlib,sys
target,expected=sys.argv[1:3]
staged=sys.argv[3] if len(sys.argv)>3 else None
def digest(path):
    result=hashlib.sha256()
    with open(path,'rb') as data:
        for chunk in iter(lambda: data.read(1<<20),b''):
            result.update(chunk)
    return result.hexdigest()
target=pathlib.Path(target)
if staged is None:
    print('present' if target.is_file() and not target.is_symlink() and digest(target)==expected else 'missing')
else:
    if digest(staged)!=expected: raise RuntimeError('Runtime archive digest mismatch')
    os.chmod(staged,0o600)
    os.replace(staged,target)
    print('staged')
`;

type ChatOutcome = "released" | "missing";

interface BuildHistory {
  /** When builds started, kept for the last hour. */
  readonly started: ReadonlyArray<number>;
  readonly failures: number;
  readonly retryAt: number;
}

/** Whether a repository may start a template build at `now`, or what holds it back. */
export function nextBuild(history: BuildHistory, now: number): "due" | "backoff" | "cap" {
  if (now < history.retryAt) return "backoff";
  const recent = history.started.filter((at) => now - at < 3_600_000);
  return recent.length >= BUILDS_PER_HOUR ? "cap" : "due";
}

/** The history after a build that started at `at` failed: the next waits twice as long. */
export function failedBuild(history: BuildHistory, at: number): BuildHistory {
  const failures = history.failures + 1;
  return {
    started: history.started.filter((started) => at - started < 3_600_000),
    failures,
    retryAt: at + Math.min(BUILD_BACKOFF_MS * 2 ** (failures - 1), BUILD_BACKOFF_MAX_MS),
  };
}

/**
 * Namespace Mac chats on per-chat compute instances. Same verbs as the Devbox
 * runtime, plus `release` and `upkeep`. A chat's durable home is a snapshot in
 * artifact storage; a Mac is whatever instance holds it now, in whatever site
 * Namespace placed it, seeded from the repository's cache volume.
 */
export function makeNamespaceMacRuntime(config: {
  readonly session: Pick<NamespaceAccountSession, "artifacts" | "issueToken">;
  readonly stateDir: string;
  readonly proxies?: Pick<NamespaceProxyManager, "open" | "restore" | "close">;
  readonly instances?: NamespaceInstances;
  readonly artifacts?: NamespaceArtifacts;
  /** Installs the box CLIs on every prepare. Tests replace the real downloads. */
  readonly toolInstall?: string;
  /** Runs a template build in the background. Tests run it when their one fake Mac is free. */
  readonly startBuild?: (build: () => Promise<void>) => void;
  /**
   * The template a chat of this repository would be frozen for now. Only a chat frozen for it
   * gets a build, so chats frozen under older config never replace a newer template.
   */
  readonly currentTemplate: (repository: string | null) => Promise<MacTemplateIdentity | null>;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
  readonly warn?: (message: string, fields: Record<string, unknown>) => void;
}) {
  const issueToken = (durationMs: number) => config.session.issueToken(durationMs);
  const instances =
    config.instances ??
    makeNamespaceInstances({
      // Mac sites are US; the account session's Compute client is regional to eu.
      compute: createClient(
        ComputeService,
        createRegionTransport("us", { tokenSource: { issueToken } }),
      ),
      nsc: nscWithToken({ stateDir: config.stateDir, issueToken }),
    });
  const artifacts =
    config.artifacts ?? makeNamespaceArtifacts({ artifacts: config.session.artifacts });
  const store = makeChatStore(config.stateDir);
  const toolInstall = config.toolInstall ?? guestToolInstallCommand();
  const publisher = makeNamespacePublisher({
    proxies: config.proxies ?? new NamespaceProxyManager(),
    ingressAuthorization: async () => `Bearer ${await issueToken(60_000)}`,
  });
  const log = (message: string, fields: Record<string, unknown>) => config.log?.(message, fields);
  const warn = (message: string, fields: Record<string, unknown>) =>
    (config.warn ?? config.log)?.(message, fields);
  const now = () => Effect.runPromise(Clock.currentTimeMillis);
  const proxyId = (operation: ProvisionOperation) => `provision-${operation.request.requestId}`;
  /** When each Mac last tried a periodic save; a new Mac starts its own cadence. */
  const lastSave = new Map<InstanceId, number>();
  /** Cache tags with a template build in flight from this manager. */
  const building = new Set<string>();
  /** Per cache tag: when its recent builds started, and how failures have pushed the next one. */
  const buildHistory = new Map<string, BuildHistory>();
  const startBuild = config.startBuild ?? ((build: () => Promise<void>) => void build());
  /** Labels every builder this manager starts, so a restarted one can find what it left. */
  const managerLabel = { "t3.manager": provisionDigest(config.stateDir).slice(0, 12) };
  const abandonAll = async (labels: Readonly<Record<string, string>>) => {
    const left = await instances.list(labels);
    for (const { instanceId } of left) await instances.depart(instanceId, "abandon");
    return left.length;
  };
  // Nothing builds in a manager that just started, so every builder labelled for it is an orphan.
  const swept = abandonAll(managerLabel).then(
    (count) => count > 0 && warn("namespace mac orphaned builders abandoned", { count }),
    (cause: unknown) => warn("namespace mac orphaned builders not swept", { cause: String(cause) }),
  );

  const guestPort = (instanceId: InstanceId): RemotePreparationPort => ({
    executePython: ({ script, stdin }) =>
      instances.exec(instanceId, ["python3", "-c", runWithXcode, script], {
        stdin,
        timeoutMs: 1_200_000,
      }),
  });

  /** Everything one chat's steps need, and the readiness its materialize produced. */
  const chat = (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    build: ProvisionRuntimeArtifact | null = null,
    record?: RecordProvisionPhase,
  ) => {
    const chatId = operation.request.requestId;
    const root = manifest.preparation.root;
    const mount = NodePath.posix.dirname(root);
    const repository = manifest.input.repository ?? null;
    const { local, guest } = desiredRuntime(manifest, build);
    const derivedHomePaths = [
      ...(manifest.preparation.artifacts ?? []).map(({ destination }) => destination),
      ...(manifest.derivedHomePaths ?? []),
    ];
    const buildCommands =
      manifest.buildPrepareCommands ?? manifest.preparation.prepareCommands ?? [];
    const frozen = frozenMacTemplate(manifest, build);
    const template = {
      mount,
      root,
      repository: manifest.preparation.repository?.url ?? null,
      ...frozen,
    };
    const cacheTag = `t3-mac-${provisionDigest(
      repository ? canonicalRepository(repository) : "none",
    ).slice(0, 12)}-v1`;
    let ready: RemotePreparationReady | null = null;
    const retention = operation.request.retentionDeadline
      ? DateTime.toEpochMillis(DateTime.makeUnsafe(operation.request.retentionDeadline))
      : Number.POSITIVE_INFINITY;

    const stageRuntime = async (instanceId: InstanceId) => {
      const check = await instances.exec(
        instanceId,
        ["python3", "-c", stageRuntimeScript, guest.archivePath, guest.sha256],
        { timeoutMs: 300_000 },
      );
      if (check.exitCode !== 0) throw new Error(`Runtime check failed: ${check.stderr.trim()}`);
      if (check.stdout.trim() === "present") return;
      const staged = `${guest.archivePath}.${NodeCrypto.randomUUID()}.partial`;
      const stopUpload = startProvisionPhase(record);
      await instances.upload(instanceId, local.path, staged);
      stopUpload("artifact.upload");
      const moved = await instances.exec(
        instanceId,
        ["python3", "-c", stageRuntimeScript, guest.archivePath, guest.sha256, staged],
        { timeoutMs: 300_000 },
      );
      if (moved.exitCode !== 0) throw new Error(`Runtime staging failed: ${moved.stderr.trim()}`);
    };

    const size =
      operation.request.provider === "namespace" && operation.request.size === "l"
        ? ("l" as const)
        : ("m" as const);

    /** A chat prepares under its own identity and runs every command; a builder only its own. */
    const prepareGuest = async (instanceId: InstanceId, builder = false) => {
      const artifactSources = await resolveNamespaceArtifactSources(
        config.session.artifacts,
        manifest,
        record,
      );
      const follow = followedBranch(manifest);
      const stopPrepare = startProvisionPhase(record);
      const prepared = await prepareRemoteHost(
        guestPort(instanceId),
        withGuestProviderInstall(
          {
            ...manifest.preparation,
            // The chat, not the machine: its Macs change and its identity must not.
            resourceIdentity: builder ? `namespace-builder:${cacheTag}` : `namespace:${chatId}`,
            // A template is shared by every chat of the repo, so no operator secrets.
            ...(builder ? { prepareCommands: buildCommands, prepareEnvironment: undefined } : {}),
            requestHash: operation.requestHash,
            preparationHash: operation.request.preparationHash,
            ...(artifactSources.length ? { artifactSources } : {}),
            ...(build ? { runtime: guest } : {}),
            ...(follow ? { follow } : {}),
            toolInstall,
            // A builder makes a template, not a chat, so it runs only the build commands.
            ...(!builder && manifest.setup ? { setup: manifest.setup } : {}),
          },
          operation.request.agentDriver,
        ),
        record,
      );
      stopPrepare("remote.prepare");
      if (
        prepared.artifactSha256 !== local.sha256 ||
        prepared.t3Revision !== local.revision ||
        prepared.projectDir !== `${root}/workspace`
      )
        throw new Error("Prepared Namespace runtime differs from its pinned inputs");
      return prepared;
    };

    const perform: ChatPerformer = {
      create: async () => {
        const stop = startProvisionPhase(record);
        const mac = await instances.create({
          labels: { "t3.chat": chatId },
          cache: { tag: cacheTag, mountPoint: mount, sizeGb: CACHE_VOLUME_GB },
          deadline: Math.min((await now()) + MAC_LIFETIME_MS, retention),
          size,
          purpose: `t3 chat ${chatId}`,
        });
        stop("mac.create");
        log("namespace mac created", { chatId, instanceId: mac.instanceId, site: mac.site });
        return mac;
      },
      materialize: async ({ instanceId, snapshot }) => {
        const port = guestPort(instanceId);
        const stopAdopt = startProvisionPhase(record);
        const adoption = await adoptChatTemplate(port, {
          ...template,
          instanceId,
          maxAgeSeconds: TEMPLATE_MAX_AGE_SECONDS,
        });
        stopAdopt(`mac.adopt.${adoption}`);
        // In parallel with this chat's own prepare, on another Mac, with its own phases.
        if (adoption !== "hit") requestBuild(chat(operation, manifest, build));
        if (snapshot !== null) {
          const stopRestore = startProvisionPhase(record);
          const url = await artifacts.downloadUrl(snapshot.artifactPath);
          if (url === null) throw new ProvisionedSandboxMissing();
          await restoreChat(port, {
            root,
            snapshot: {
              url,
              sha256: snapshot.sha256,
            },
            accessToken: manifest.preparation.repository?.accessToken,
          });
          stopRestore("mac.restore", { bytes: snapshot.bytes });
        }
        await stageRuntime(instanceId);
        ready = await prepareGuest(instanceId);
        log("namespace mac materialized", {
          chatId,
          instanceId,
          adoption,
          restored: snapshot?.generation ?? null,
        });
      },
      save: async (step) => {
        const started = await now();
        const path = `t3/chats/${chatId}/${step.generation}-${NodeCrypto.randomUUID()}.tar`;
        const upload = await artifacts.beginUpload({
          path,
          // A lease with a retention deadline keeps its snapshot no longer than that.
          expiresAt: Math.min(started + SNAPSHOT_RETENTION_MS, retention),
          labels: { "t3.chat": chatId },
        });
        const saved = await saveChat(guestPort(step.instanceId), {
          root,
          mode: step.mode,
          uploadUrl: upload.signedUploadUrl,
          maxBytes: SNAPSHOT_MAX_BYTES,
          previousFingerprint: step.previousFingerprint,
          derivedHomePaths,
        });
        if (saved.kind === "unchanged") {
          log("namespace mac chat unchanged", { chatId, mode: step.mode });
          return { kind: "unchanged" };
        }
        const finalized = await artifacts.finalize(upload.uploadId);
        log("namespace mac chat saved", {
          chatId,
          mode: step.mode,
          generation: step.generation,
          bytes: saved.bytes,
          durationMs: (await now()) - started,
        });
        return {
          kind: "saved",
          artifactPath: finalized.path,
          sha256: saved.sha256,
          bytes: saved.bytes,
          fingerprint: saved.fingerprint,
          savedAt: started,
        };
      },
      depart: async ({ instanceId }) => {
        // A chat ran on this volume, so nothing of it may become the cache's next parent.
        await instances.depart(instanceId, "abandon");
        log("namespace mac departed", { chatId, instanceId });
      },
      expire: async ({ paths }) => {
        for (const path of paths) await artifacts.expire(path);
      },
    };
    const ports: ChatPorts = {
      chatId,
      store,
      perform,
      facts: async () => ({
        instances: (await instances.list({ "t3.chat": chatId })).map(
          ({ instanceId }) => instanceId,
        ),
        artifacts: (await artifacts.list({ "t3.chat": chatId })).map(({ path }) => path),
        now: await now(),
      }),
    };
    return {
      chatId,
      ports,
      prepareGuest,
      stageRuntime,
      template,
      frozen,
      repository,
      cacheTag,
      size,
      files: manifest.preparation.files.map(({ scope, destination }) => ({ scope, destination })),
      derivedHomePaths,
      readied: () => ready,
    };
  };
  type ChatContext = ReturnType<typeof chat>;

  const isCurrent = async (context: ChatContext) => {
    const current = await config.currentTemplate(context.repository);
    return (
      current?.key === context.frozen.key && current.runtimeSha256 === context.frozen.runtimeSha256
    );
  };

  /**
   * Fills the cache volume of whatever site Namespace places it in with a template prepared from
   * this chat's manifest: a Mac with no chat, no turns and no background commands, which adopts,
   * prepares, seals, scrubs and commits. A current template there is left as it is.
   */
  const buildTemplate = async (context: ChatContext) => {
    const { cacheTag: tag } = context;
    const labels = { "t3.builder": tag, ...managerLabel };
    const started = await now();
    const mac = await instances
      .create({
        labels,
        cache: { tag, mountPoint: context.template.mount, sizeGb: CACHE_VOLUME_GB },
        deadline: started + BUILDER_LIFETIME_MS,
        size: context.size,
        purpose: `t3 template ${tag}`,
      })
      .catch(async (cause: unknown) => {
        // A create that failed after Namespace made the instance leaves it running.
        await abandonAll(labels).catch(() => undefined);
        throw cause;
      });
    const { instanceId } = mac;
    const port = guestPort(instanceId);
    let adoption: string | null = null;
    let departure: Departure = "abandon";
    try {
      adoption = await adoptChatTemplate(port, {
        ...context.template,
        instanceId,
        maxAgeSeconds: TEMPLATE_MAX_AGE_SECONDS,
      });
      if (adoption === "hit") return;
      await context.stageRuntime(instanceId);
      await context.prepareGuest(instanceId, true);
      // The config may have moved on while this prepared; a superseded template never replaces one.
      if (!(await isCurrent(context))) {
        log("namespace mac template build skipped", { tag, reason: "superseded" });
        return;
      }
      const templateDigest = await sealChatTemplate(port, {
        ...context.template,
        files: context.files,
        derivedHomePaths: context.derivedHomePaths,
      });
      await scrubChatRoot(port, {
        mount: context.template.mount,
        root: context.template.root,
        templateDigest,
      });
      departure = "commit";
    } finally {
      await instances.depart(instanceId, departure);
      log("namespace mac template build", {
        tag,
        instanceId,
        site: mac.site,
        adoption,
        departure,
        durationMs: (await now()) - started,
      });
    }
  };

  /** Starts a build unless the chat is out of date, one runs already, or the bounds say wait. */
  const buildIfDue = async (context: ChatContext) => {
    const tag = context.cacheTag;
    await swept;
    if (!(await isCurrent(context))) {
      log("namespace mac template build skipped", { tag, reason: "superseded" });
      return;
    }
    const at = await now();
    const history = buildHistory.get(tag) ?? { started: [], failures: 0, retryAt: 0 };
    const due = nextBuild(history, at);
    if (due !== "due") {
      warn("namespace mac template build suppressed", { tag, reason: due });
      return;
    }
    // Another manager, or this one before a restart, may be building already.
    if ((await instances.list({ "t3.builder": tag })).length > 0) {
      log("namespace mac template build skipped", { tag, reason: "running" });
      return;
    }
    const started = {
      ...history,
      started: [...history.started.filter((before) => at - before < 3_600_000), at],
    };
    buildHistory.set(tag, started);
    try {
      await buildTemplate(context);
      buildHistory.set(tag, { ...started, failures: 0, retryAt: 0 });
    } catch (cause) {
      buildHistory.set(tag, failedBuild(started, at));
      throw cause;
    }
  };

  /** At most one build per repository's cache at a time; a failed one waits for the next miss. */
  const requestBuild = (context: ChatContext) => {
    if (building.has(context.cacheTag)) return;
    building.add(context.cacheTag);
    startBuild(() =>
      buildIfDue(context)
        .catch((cause: unknown) =>
          warn("namespace mac template build failed", {
            tag: context.cacheTag,
            cause: String(cause),
          }),
        )
        .finally(() => building.delete(context.cacheTag)),
    );
  };

  const liveMac = (record: ChatRecord | null) => {
    if (record?.kind !== "live") throw new Error("This Namespace chat has no Mac");
    return record.mac.incarnation.instanceId;
  };

  /** Brings the chat up on a Mac, restoring its snapshot when it has one, and returns its readiness. */
  const open = async (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    record?: RecordProvisionPhase,
    build: ProvisionRuntimeArtifact | null = null,
  ) => {
    const current = chat(operation, manifest, build, record);
    // A released chat whose snapshot expired has nothing to restore: no Mac is opened for it.
    const before = await store.read(current.chatId);
    if (
      before?.kind === "idle" &&
      before.snapshot !== null &&
      (await artifacts.downloadUrl(before.snapshot.artifactPath)) === null
    )
      throw new ProvisionedSandboxMissing();
    const opened = await drive("open", current.ports);
    return current.readied() ?? (await current.prepareGuest(liveMac(opened)));
  };

  const outcome = (record: ChatRecord | null): ChatOutcome =>
    record?.snapshot ? "released" : "missing";

  /**
   * A Mac that vanished leaves the chat idle on its current snapshot. Settled against the record
   * as it is when written, so a release or resume that landed since the caller looked stands.
   */
  const settleGone = async (chatId: string, instanceId: InstanceId) => {
    lastSave.delete(instanceId);
    const settled = await store.update(chatId, (current) =>
      settle(current, { kind: "lost", instanceId }),
    );
    const current = settled.ok ? settled.record : await store.read(chatId);
    return current?.kind === "live" ? ("running" as const) : outcome(current);
  };

  /** Runs a goal that ends the chat's Mac, then drops that Mac's save cadence. */
  const endingMac = async <A>(chatId: string, run: () => Promise<A>) => {
    const before = await store.read(chatId);
    try {
      return await run();
    } finally {
      if (before?.kind === "live") lastSave.delete(before.mac.incarnation.instanceId);
    }
  };

  const release = (operation: ProvisionOperation, manifest: ProvisionPreparationManifest) =>
    endingMac(operation.request.requestId, async () =>
      outcome(await drive("release", chat(operation, manifest).ports)),
    );

  const publish = (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    instanceId: InstanceId,
    recorded?: NamespaceProxyLease,
    record?: RecordProvisionPhase,
  ) => {
    if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
    return publisher.publish({
      proxyId: proxyId(operation),
      environmentId: operation.state.readiness.environmentId,
      upstream: () => instances.expose(instanceId, manifest.preparation.port),
      ...(recorded ? { recorded } : {}),
      ...(record ? { record } : {}),
    });
  };

  return {
    prepare: open,
    attach: async (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      record?: RecordProvisionPhase,
    ) => {
      if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
      const instanceId = liveMac(await store.read(operation.request.requestId));
      const { credential, brokerToken } = await mintNamespacePairing(
        guestPort(instanceId),
        {
          root: manifest.preparation.root,
          port: manifest.preparation.port,
          environmentId: operation.state.readiness.environmentId,
        },
        record,
      );
      const namespaceProxy = await publish(operation, manifest, instanceId, recordedProxy, record);
      return {
        pairingUrl: `${namespaceProxy.proxyOrigin}/pair#token=${encodeURIComponent(credential)}`,
        namespaceProxy,
        remoteAccess: { origin: namespaceProxy.proxyOrigin, brokerToken },
      };
    },
    /** Brings a released chat back on a new Mac, at the origin its client saved. */
    resume: async (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      build: ProvisionRuntimeArtifact | null = null,
    ) => {
      if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
      const ready = await open(operation, manifest, undefined, build);
      if (ready.environmentId !== operation.state.readiness.environmentId)
        throw new Error("Namespace chat environment identity changed");
      const instanceId = liveMac(await store.read(operation.request.requestId));
      return {
        namespaceProxy: await publish(operation, manifest, instanceId, recordedProxy),
        refreshError: ready.refreshError ?? null,
      };
    },
    /** Serves a running chat at its recorded origin again, as after a manager restart. */
    reconnect: async (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy: NamespaceProxyLease,
    ) =>
      publish(
        operation,
        manifest,
        liveMac(await store.read(operation.request.requestId)),
        recordedProxy,
      ),
    /** Saves the chat off the Mac, then lets the Mac go. Never destroys before the save is recorded. */
    release,
    touch: async (operation: ProvisionOperation) => {
      const chatId = operation.request.requestId;
      const record = await store.read(chatId);
      if (record?.kind !== "live") return outcome(record);
      const alive = (await instances.list({ "t3.chat": chatId })).some(
        ({ instanceId }) => instanceId === record.mac.incarnation.instanceId,
      );
      return alive ? ("running" as const) : settleGone(chatId, record.mac.incarnation.instanceId);
    },
    /**
     * One upkeep pass for an awake chat: release a Mac nearing its deadline,
     * idle ones first, otherwise save what changed since the last pass. Only a
     * chat confirmed idle is released to sleep; any other awake chat off its Mac,
     * or on one it was never restored onto, is `reopen`, owed a ready Mac, so a
     * host restart at any point of a move still finishes it.
     */
    upkeep: async (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      idle: () => Promise<boolean>,
    ): Promise<"kept" | "reopen" | ChatOutcome> => {
      const chatId = operation.request.requestId;
      const reopen = (outcome: ChatOutcome) => (outcome === "released" ? "reopen" : outcome);
      const record = await store.read(chatId);
      if (record?.kind !== "live") return reopen(outcome(record));
      const current = chat(operation, manifest);
      const facts = await current.ports.facts();
      if (!facts.instances.includes(record.mac.incarnation.instanceId)) {
        const gone = await settleGone(chatId, record.mac.incarnation.instanceId);
        return gone === "running" ? "kept" : reopen(gone);
      }
      // A host that died while restoring the chat left this Mac unready; reopening restores onto it.
      if (record.mac.cache === "unknown") return "reopen";
      const instanceId = record.mac.incarnation.instanceId;
      const left = record.mac.incarnation.deadline - facts.now;
      if (left < ROTATE_IDLE_MS) {
        const asleep = await idle();
        if (asleep || left < ROTATE_FORCE_MS) {
          log("namespace mac released before its deadline", { chatId, leftMs: left, asleep });
          const released = await release(operation, manifest);
          return asleep ? released : reopen(released);
        }
      }
      const last = lastSave.get(instanceId);
      if (last !== undefined && facts.now - last < SAVE_INTERVAL_MS) return "kept";
      lastSave.set(instanceId, facts.now);
      const saved = await periodicSave(current.ports);
      log("namespace mac periodic save", { chatId, result: saved });
      return "kept";
    },
    dispose: async (operation: ProvisionOperation, manifest: ProvisionPreparationManifest) => {
      await publisher.close(proxyId(operation));
      await endingMac(operation.request.requestId, () =>
        drive("dispose", chat(operation, manifest).ports),
      );
    },
  };
}
