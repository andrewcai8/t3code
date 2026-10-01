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
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import {
  desiredRuntime,
  followedBranch,
  provisionDigest,
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
/** A template older than this is still adopted, but its chat refills it. */
const TEMPLATE_MAX_AGE_SECONDS = 86_400;
/** Inside this much of its deadline an idle Mac is released; inside the second, a busy one too. */
const ROTATE_IDLE_MS = 30 * 60_000;
const ROTATE_FORCE_MS = 8 * 60_000;

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
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
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
  const now = () => Effect.runPromise(Clock.currentTimeMillis);
  const proxyId = (operation: ProvisionOperation) => `provision-${operation.request.requestId}`;

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
    const derivedHomePaths = (manifest.preparation.artifacts ?? []).map(
      ({ destination }) => destination,
    );
    const template = {
      mount,
      root,
      repository: manifest.preparation.repository?.url ?? null,
      // What preparation builds: a change makes the volume's template stale.
      key: provisionDigest(
        JSON.stringify([
          manifest.preparation.prepareCommands ?? [],
          manifest.preparation.artifacts ?? [],
          manifest.preparation.providerInstall ?? "",
        ]),
      ),
      runtimeSha256: guest.sha256,
    };
    const cacheTag = `t3-mac-${provisionDigest(
      repository ? canonicalRepository(repository) : "none",
    ).slice(0, 12)}-v1`;
    let ready: RemotePreparationReady | null = null;

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

    const prepareGuest = async (instanceId: InstanceId) => {
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
            resourceIdentity: `namespace:${chatId}`,
            requestHash: operation.requestHash,
            preparationHash: operation.request.preparationHash,
            ...(artifactSources.length ? { artifactSources } : {}),
            ...(build ? { runtime: guest } : {}),
            ...(follow ? { follow } : {}),
            toolInstall,
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
        const retention = operation.request.retentionDeadline
          ? DateTime.toEpochMillis(DateTime.makeUnsafe(operation.request.retentionDeadline))
          : Number.POSITIVE_INFINITY;
        const mac = await instances.create({
          labels: { "t3.chat": chatId },
          cache: { tag: cacheTag, mountPoint: mount, sizeGb: CACHE_VOLUME_GB },
          deadline: Math.min((await now()) + MAC_LIFETIME_MS, retention),
          size:
            operation.request.provider === "namespace" && operation.request.size === "l"
              ? "l"
              : "m",
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
        if (snapshot !== null) {
          const stopRestore = startProvisionPhase(record);
          await restoreChat(port, {
            root,
            snapshot: {
              url: await artifacts.downloadUrl(snapshot.artifactPath),
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
        return { adoption };
      },
      seal: async ({ instanceId }) => {
        const stop = startProvisionPhase(record);
        try {
          await sealChatTemplate(guestPort(instanceId), {
            ...template,
            files: manifest.preparation.files.map(({ scope, destination }) => ({
              scope,
              destination,
            })),
            derivedHomePaths,
          });
          stop("mac.seal");
          return { sealed: true };
        } catch (cause) {
          // The chat runs either way; only this site's cache stays unfilled.
          log("namespace mac template not sealed", { chatId, instanceId, cause: String(cause) });
          return { sealed: false };
        }
      },
      save: async (step) => {
        const started = await now();
        const path = `t3/chats/${chatId}/${step.generation}-${NodeCrypto.randomUUID()}.tar`;
        const upload = await artifacts.beginUpload({
          path,
          expiresAt: started + SNAPSHOT_RETENTION_MS,
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
      depart: async ({ instanceId, departure }) => {
        // Only a filler's sealed template may become the cache's next parent. A scrub that fails
        // leaves the chat on the volume, so that Mac abandons: the snapshot is already recorded.
        const leaving =
          departure === "commit" &&
          (await scrubChatRoot(guestPort(instanceId), { mount, root }).then(
            () => true,
            (cause: unknown) => {
              log("namespace mac template not committed", {
                chatId,
                instanceId,
                cause: String(cause),
              });
              return false;
            },
          ))
            ? "commit"
            : "abandon";
        await instances.depart(instanceId, leaving);
        log("namespace mac departed", { chatId, instanceId, departure: leaving });
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
    return { chatId, ports, prepareGuest, readied: () => ready };
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
    const settled = await store.update(chatId, (current) =>
      settle(current, { kind: "lost", instanceId }),
    );
    const current = settled.ok ? settled.record : await store.read(chatId);
    return current?.kind === "live" ? ("running" as const) : outcome(current);
  };

  const release = async (operation: ProvisionOperation, manifest: ProvisionPreparationManifest) => {
    const released = await drive("release", chat(operation, manifest).ports);
    return outcome(released);
  };

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
     * idle ones first, otherwise save what changed since the last pass.
     */
    upkeep: async (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      busy: () => Promise<boolean>,
    ): Promise<"kept" | ChatOutcome> => {
      const chatId = operation.request.requestId;
      const record = await store.read(chatId);
      if (record?.kind !== "live") return outcome(record);
      const current = chat(operation, manifest);
      const facts = await current.ports.facts();
      if (!facts.instances.includes(record.mac.incarnation.instanceId)) {
        const gone = await settleGone(chatId, record.mac.incarnation.instanceId);
        return gone === "running" ? "kept" : gone;
      }
      const left = record.mac.incarnation.deadline - facts.now;
      if (left < ROTATE_FORCE_MS || (left < ROTATE_IDLE_MS && !(await busy()))) {
        log("namespace mac released before its deadline", { chatId, leftMs: left });
        return release(operation, manifest);
      }
      const saved = await periodicSave(current.ports);
      log("namespace mac periodic save", { chatId, result: saved });
      return "kept";
    },
    dispose: async (operation: ProvisionOperation, manifest: ProvisionPreparationManifest) => {
      await publisher.close(proxyId(operation));
      await drive("dispose", chat(operation, manifest).ports);
    },
  };
}
