// @effect-diagnostics globalDate:off - Modal deadlines and snapshot ages are wall-clock times at the SDK boundary.
import { ModalClient, NotFoundError, type Sandbox } from "modal";
import type { ProvisionOperation } from "@t3tools/contracts";

import type { ProvisionRuntimeArtifact } from "./config.ts";
import { ProvisionedSandboxMissing } from "./driver.ts";
import { withGuestProviderInstall } from "./guestProviderInstall.ts";
import { makeModalChatStore, type ModalChatRecord } from "./modalChatStore.ts";
import { makeNamespacePublisher, mintNamespacePairing } from "./NamespaceProvisionRuntime.ts";
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import {
  desiredRuntime,
  fileDigest,
  followedBranch,
  type ProvisionPreparationManifest,
} from "./ProvisionPreparation.ts";
import { startProvisionPhase, type RecordProvisionPhase } from "./provisionTiming.ts";
import { retentionTimeoutMs } from "./retention.ts";
import {
  checkRemoteHost,
  prepareRemoteHost,
  type RemotePreparationPort,
} from "./remotePreparation.ts";

/** Modal ends a sandbox at this age without saving it, so upkeep snapshots it before then. */
const BOX_LIFETIME_MS = 24 * 3_600_000;
/** Past this age an idle box is put to sleep; past the second, a busy one is moved too. */
const ROTATE_IDLE_MS = BOX_LIFETIME_MS - 60 * 60_000;
const ROTATE_FORCE_MS = BOX_LIFETIME_MS - 20 * 60_000;
/** A memory snapshot, and every snapshot restored from it, expires this long after it was taken. */
const SNAPSHOT_LIFETIME_MS = 7 * 86_400_000;
const PREPARE_TIMEOUT_MS = 1_200_000;
/** The image's user, as the E2B template has it; Modal runs every exec as root. */
const AS_USER = [
  "setpriv",
  "--reuid=user",
  "--regid=user",
  "--init-groups",
  "--",
  "env",
  "HOME=/home/user",
  "USER=user",
  "LOGNAME=user",
];

export interface ModalBoxSpec {
  readonly app: string;
  readonly name: string;
  readonly imageId: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly sizing: {
    readonly cpu: number;
    readonly cpuLimit: number;
    readonly memoryMiB: number;
    readonly memoryLimitMiB: number;
  };
  readonly tags: Readonly<Record<string, string>>;
  readonly egress: {
    readonly domains: ReadonlyArray<string>;
    readonly cidrs: ReadonlyArray<string>;
  };
}

/** What the runtime asks of Modal. Every sandbox of a chat carries the chat's name. */
export interface ModalBoxes {
  /** The running sandbox named `name`, if any. */
  readonly find: (app: string, name: string) => Promise<string | null>;
  /** Fails with `"exists"` when a running sandbox already has the name. */
  readonly create: (spec: ModalBoxSpec) => Promise<string | "exists">;
  /** A new sandbox from the snapshot, under the name it was taken with; `"exists"` as for create. */
  readonly restore: (snapshotId: string) => Promise<string | "exists" | "expired">;
  /** Takes a memory snapshot, which ends the sandbox. */
  readonly snapshot: (sandboxId: string) => Promise<string>;
  readonly alive: (sandboxId: string) => Promise<boolean>;
  readonly terminate: (sandboxId: string) => Promise<void>;
  readonly tunnel: (sandboxId: string, port: number) => Promise<string>;
  readonly exec: (
    sandboxId: string,
    argv: ReadonlyArray<string>,
    options: { readonly stdin?: string; readonly timeoutMs: number },
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  readonly upload: (sandboxId: string, localPath: string, remotePath: string) => Promise<void>;
}

const cidr = /^[0-9.:a-fA-F]+(?:\/\d+)?$/;

export function makeModalBoxes(credentials: {
  readonly tokenId: string;
  readonly tokenSecret: string;
}): ModalBoxes {
  const modal = new ModalClient(credentials);
  const box = (sandboxId: string) => modal.sandboxes.fromId(sandboxId);
  const isRunning = async (sandbox: Sandbox) => (await sandbox.poll()) === null;
  const nameTaken = (error: unknown) =>
    error instanceof Error && /ALREADY_EXISTS|already in use/i.test(error.message);
  return {
    find: async (app, name) => {
      try {
        const sandbox = await modal.sandboxes.fromName(app, name);
        return (await isRunning(sandbox)) ? sandbox.sandboxId : null;
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    create: async (spec) => {
      const app = await modal.apps.fromName(spec.app, { createIfMissing: true });
      const image = await modal.images.fromId(spec.imageId);
      try {
        const sandbox = await modal.sandboxes.create(app, image, {
          name: spec.name,
          runtime: "vm",
          // A snapshot keeps every process, which is what lets a chat sleep without a restart.
          experimentalEnableSnapshot: true,
          encryptedPorts: [spec.port],
          timeoutMs: spec.timeoutMs,
          ...spec.sizing,
          tags: { ...spec.tags },
          ...(spec.egress.domains.length
            ? { outboundDomainAllowlist: [...spec.egress.domains] }
            : {}),
          ...(spec.egress.cidrs.length ? { outboundCidrAllowlist: [...spec.egress.cidrs] } : {}),
        });
        return sandbox.sandboxId;
      } catch (error) {
        if (nameTaken(error)) return "exists";
        throw error;
      }
    },
    restore: async (snapshotId) => {
      try {
        const snapshot = await modal.sandboxSnapshots.fromId(snapshotId);
        return (await modal.sandboxes.experimentalFromSnapshot(snapshot)).sandboxId;
      } catch (error) {
        if (nameTaken(error)) return "exists";
        if (error instanceof Error && /NOT_FOUND|not found/i.test(error.message)) return "expired";
        throw error;
      }
    },
    snapshot: async (sandboxId) => (await (await box(sandboxId)).experimentalSnapshot()).snapshotId,
    alive: async (sandboxId) => {
      try {
        return await isRunning(await box(sandboxId));
      } catch (error) {
        if (error instanceof Error && /NOT_FOUND|not found/i.test(error.message)) return false;
        throw error;
      }
    },
    terminate: async (sandboxId) => (await box(sandboxId)).terminate(),
    tunnel: async (sandboxId, port) => {
      const tunnel = (await (await box(sandboxId)).tunnels())[port];
      if (!tunnel) throw new Error("The Modal box has no tunnel to its T3 port");
      return tunnel.url;
    },
    exec: async (sandboxId, argv, { stdin, timeoutMs }) => {
      const child = await (await box(sandboxId)).exec([...argv], { timeoutMs });
      if (stdin) await child.stdin.writeText(stdin);
      await child.stdin.close();
      const [stdout, stderr, exitCode] = await Promise.all([
        child.stdout.readText(),
        child.stderr.readText(),
        child.wait(),
      ]);
      return { exitCode, stdout, stderr };
    },
    upload: async (sandboxId, localPath, remotePath) => {
      const sandbox = await box(sandboxId);
      await sandbox.filesystem.copyFromLocal(localPath, remotePath);
      // Copied as root; the guest reads it as the image's user.
      const chmod = await sandbox.exec(["chmod", "0644", remotePath]);
      if ((await chmod.wait()) !== 0) throw new Error("The runtime archive could not be shared");
    },
  };
}

/** Splits configured egress hosts into the domains and CIDRs Modal takes separately. */
export function modalEgress(allow: ReadonlyArray<string>) {
  return {
    domains: allow.filter((entry) => !cidr.test(entry)),
    cidrs: allow.filter((entry) => cidr.test(entry)),
  };
}

type ChatOutcome = "released" | "missing";

/**
 * Chats on Modal sandboxes. A chat names no sandbox: it runs on whichever one carries its name,
 * and sleeps as a memory snapshot that a wake restores onto a new one, processes and all. Every
 * step of one chat runs in turn, so no exec of this runtime is in flight when a snapshot is taken.
 */
export function makeModalRuntime(config: {
  readonly boxes: ModalBoxes;
  readonly stateDir: string;
  readonly proxies?: Pick<NamespaceProxyManager, "open" | "restore" | "close">;
  readonly now?: () => number;
  readonly log?: (message: string, fields: Record<string, unknown>) => void;
}) {
  const { boxes } = config;
  const store = makeModalChatStore(config.stateDir);
  const now = config.now ?? Date.now;
  const log = (message: string, fields: Record<string, unknown>) => config.log?.(message, fields);
  // A Modal tunnel passes the client's own authorization through, so the proxy adds none.
  const publisher = makeNamespacePublisher({
    proxies: config.proxies ?? new NamespaceProxyManager(),
    ingressAuthorization: async () => "",
  });
  const turns = new Map<string, Promise<unknown>>();
  const inTurn = <A>(chatId: string, run: () => Promise<A>): Promise<A> => {
    const result = (turns.get(chatId) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => undefined);
    turns.set(chatId, settled);
    void settled.then(() => {
      if (turns.get(chatId) === settled) turns.delete(chatId);
    });
    return result;
  };
  const request = (operation: ProvisionOperation) => {
    if (operation.request.provider !== "modal") throw new Error("Not a Modal chat");
    return operation.request;
  };
  const chatId = (operation: ProvisionOperation) => operation.request.requestId;
  const boxName = (operation: ProvisionOperation) => `t3-chat-${chatId(operation)}`;
  const proxyId = (operation: ProvisionOperation) => `provision-${chatId(operation)}`;
  const expired = (chainStartedAt: number | null) =>
    chainStartedAt !== null && now() - chainStartedAt >= SNAPSHOT_LIFETIME_MS;

  const guestPort = (sandboxId: string): RemotePreparationPort => ({
    executePython: ({ script, stdin }) =>
      boxes.exec(sandboxId, [...AS_USER, "python3", "-c", script], {
        stdin,
        timeoutMs: PREPARE_TIMEOUT_MS,
      }),
  });
  const guestInput = (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    extra: { readonly runtime?: ProvisionPreparationManifest["preparation"]["artifact"] } = {},
  ) => {
    const follow = followedBranch(manifest);
    return withGuestProviderInstall(
      {
        ...manifest.preparation,
        // The chat, not the sandbox: its sandboxes change and its identity must not.
        resourceIdentity: `modal:${chatId(operation)}`,
        requestHash: operation.requestHash,
        preparationHash: operation.request.preparationHash,
        ...extra,
        ...(follow ? { follow } : {}),
        ...(manifest.setup ? { setup: manifest.setup } : {}),
      },
      operation.request.agentDriver,
    );
  };

  /**
   * The running sandbox of the chat, after waking it from its snapshot or creating its first
   * one. A sandbox already carrying the chat's name is adopted, which is what a step a crash cut
   * off left behind.
   */
  const awake = async (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    record?: RecordProvisionPhase,
  ): Promise<string> => {
    const modal = request(operation);
    const id = chatId(operation);
    const name = boxName(operation);
    const current = await store.read(id);
    if (current?.kind === "awake" || current?.kind === "saving") {
      if (await boxes.alive(current.sandboxId)) {
        if (current.kind === "saving") await store.write(id, { ...current, kind: "awake" });
        return current.sandboxId;
      }
      // Modal ended it without a snapshot this manager recorded.
      throw new ProvisionedSandboxMissing();
    }
    if (current?.kind === "asleep") {
      if (expired(current.chainStartedAt)) throw new ProvisionedSandboxMissing();
      const stop = startProvisionPhase(record);
      const restored = await boxes.restore(current.snapshotId);
      const sandboxId = restored === "exists" ? await boxes.find(modal.app, name) : restored;
      if (sandboxId === null || sandboxId === "expired") throw new ProvisionedSandboxMissing();
      stop("modal.restore");
      await store.write(id, {
        kind: "awake",
        sandboxId,
        startedAt: now(),
        chainStartedAt: current.chainStartedAt,
      });
      log("modal chat restored", { chatId: id, sandboxId });
      return sandboxId;
    }
    const stop = startProvisionPhase(record);
    const created = await boxes.create({
      app: modal.app,
      name,
      imageId: modal.imageId,
      port: manifest.preparation.port,
      timeoutMs: retentionTimeoutMs(operation.request.retentionDeadline, BOX_LIFETIME_MS),
      sizing: modal.sizing,
      tags: {
        provision_request_id: id,
        preparation_hash: operation.request.preparationHash,
        account: operation.request.providerInstanceId,
      },
      egress: modalEgress(manifest.egressAllow),
    });
    const sandboxId = created === "exists" ? await boxes.find(modal.app, name) : created;
    if (sandboxId === null) throw new Error("The Modal box named for this chat could not be found");
    stop("modal.create");
    await store.write(id, { kind: "awake", sandboxId, startedAt: now(), chainStartedAt: null });
    log("modal chat created", { chatId: id, sandboxId });
    return sandboxId;
  };

  const prepareOn = async (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    sandboxId: string,
    build: ProvisionRuntimeArtifact | null,
    record?: RecordProvisionPhase,
  ) => {
    const { local: desired, guest } = desiredRuntime(manifest, build);
    if ((await fileDigest(desired.path)) !== desired.sha256)
      throw new Error("The stored runtime artifact changed.");
    const installed = `${manifest.preparation.root}/${
      guest.sha256 === manifest.preparation.artifact.sha256 ? "artifact" : `runtime/${guest.sha256}`
    }`;
    const stopPresence = startProvisionPhase(record);
    const staged = await boxes.exec(
      sandboxId,
      [
        ...AS_USER,
        "sh",
        "-c",
        'test -d "$1" || sha256sum "$2"',
        "sh",
        installed,
        guest.archivePath,
      ],
      { timeoutMs: PREPARE_TIMEOUT_MS },
    );
    stopPresence("artifact.presence");
    if (staged.exitCode !== 0 || (staged.stdout && !staged.stdout.startsWith(desired.sha256))) {
      const stopUpload = startProvisionPhase(record);
      await boxes.upload(sandboxId, desired.path, guest.archivePath);
      stopUpload("artifact.upload");
    }
    const stopPrepare = startProvisionPhase(record);
    const prepared = await prepareRemoteHost(
      guestPort(sandboxId),
      guestInput(operation, manifest, build ? { runtime: guest } : {}),
      record,
    );
    stopPrepare("remote.prepare");
    if (
      prepared.artifactSha256 !== desired.sha256 ||
      prepared.t3Revision !== desired.revision ||
      prepared.projectDir !== `${manifest.preparation.root}/workspace`
    )
      throw new Error("Prepared runtime does not match the pinned artifact and workspace.");
    return prepared;
  };

  const awakeBox = async (operation: ProvisionOperation) => {
    const current = await store.read(chatId(operation));
    if (current?.kind !== "awake") throw new Error("This Modal chat has no running box");
    return current.sandboxId;
  };

  const publish = (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    sandboxId: string,
    recorded?: NamespaceProxyLease,
    record?: RecordProvisionPhase,
  ) => {
    if (operation.state.kind !== "ready") throw new Error("Modal environment is not ready");
    return publisher.publish({
      proxyId: proxyId(operation),
      environmentId: operation.state.readiness.environmentId,
      upstream: () => boxes.tunnel(sandboxId, manifest.preparation.port),
      ...(recorded ? { recorded } : {}),
      ...(record ? { record } : {}),
    });
  };

  /** Snapshots an awake chat, which ends its box. Never forgets the box before the snapshot is recorded. */
  const sleep = async (operation: ProvisionOperation): Promise<ChatOutcome> => {
    const id = chatId(operation);
    const current = await store.read(id);
    if (current === null) return "missing";
    if (current.kind === "asleep") return expired(current.chainStartedAt) ? "missing" : "released";
    if (!(await boxes.alive(current.sandboxId))) return "missing";
    await store.write(id, { ...current, kind: "saving" });
    const started = now();
    const snapshotId = await boxes.snapshot(current.sandboxId);
    await store.write(id, {
      kind: "asleep",
      snapshotId,
      chainStartedAt: current.chainStartedAt ?? started,
    });
    log("modal chat snapshotted", { chatId: id, durationMs: now() - started });
    return "released";
  };

  return {
    prepare: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      record?: RecordProvisionPhase,
      build: ProvisionRuntimeArtifact | null = null,
    ) =>
      inTurn(chatId(operation), async () => {
        const sandboxId = await awake(operation, manifest, record);
        return prepareOn(operation, manifest, sandboxId, build, record);
      }),
    attach: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      record?: RecordProvisionPhase,
    ) =>
      inTurn(chatId(operation), async () => {
        if (operation.state.kind !== "ready") throw new Error("Modal environment is not ready");
        const sandboxId = await awakeBox(operation);
        const { credential, brokerToken } = await mintNamespacePairing(
          guestPort(sandboxId),
          {
            root: manifest.preparation.root,
            port: manifest.preparation.port,
            environmentId: operation.state.readiness.environmentId,
          },
          record,
        );
        const namespaceProxy = await publish(operation, manifest, sandboxId, recordedProxy, record);
        return {
          pairingUrl: `${namespaceProxy.proxyOrigin}/pair#token=${encodeURIComponent(credential)}`,
          namespaceProxy,
          remoteAccess: { origin: namespaceProxy.proxyOrigin, brokerToken },
        };
      }),
    /** Wakes a chat at the origin its client saved, starting its T3 server again if it is down. */
    resume: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      build: ProvisionRuntimeArtifact | null = null,
    ) =>
      inTurn(chatId(operation), async () => {
        const sandboxId = await awake(operation, manifest);
        const checked = await checkRemoteHost(
          guestPort(sandboxId),
          guestInput(operation, manifest),
        );
        const refreshError = checked.serverReady
          ? checked.refreshError
          : ((await prepareOn(operation, manifest, sandboxId, build)).refreshError ?? null);
        return {
          namespaceProxy: await publish(operation, manifest, sandboxId, recordedProxy),
          refreshError,
          restarted: !checked.serverReady,
        };
      }),
    /** Serves an awake chat at its recorded origin again, as after a manager restart. */
    reconnect: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy: NamespaceProxyLease,
    ) =>
      inTurn(chatId(operation), async () =>
        publish(operation, manifest, await awakeBox(operation), recordedProxy),
      ),
    release: (operation: ProvisionOperation) => inTurn(chatId(operation), () => sleep(operation)),
    touch: (operation: ProvisionOperation) =>
      inTurn(chatId(operation), async (): Promise<"running" | ChatOutcome> => {
        const current = await store.read(chatId(operation));
        if (current === null) return "missing";
        if (current.kind === "asleep")
          return expired(current.chainStartedAt) ? "missing" : "released";
        return (await boxes.alive(current.sandboxId)) ? "running" : "missing";
      }),
    /**
     * One upkeep pass for an awake chat: a box nearing Modal's lifetime cap is snapshotted, an
     * idle one to sleep and a busy one to be woken again on a new box.
     */
    upkeep: (operation: ProvisionOperation, idle: () => Promise<boolean>) =>
      inTurn(chatId(operation), async (): Promise<"kept" | "reopen" | ChatOutcome> => {
        const current: ModalChatRecord | null = await store.read(chatId(operation));
        if (current === null) return "missing";
        if (current.kind === "asleep")
          return expired(current.chainStartedAt) ? "missing" : "reopen";
        if (!(await boxes.alive(current.sandboxId))) return "missing";
        const age = now() - current.startedAt;
        if (age < ROTATE_IDLE_MS) return "kept";
        const asleep = await idle();
        if (!asleep && age < ROTATE_FORCE_MS) return "kept";
        log("modal chat rotated before its lifetime cap", {
          chatId: chatId(operation),
          age,
          asleep,
        });
        const slept = await sleep(operation);
        return asleep || slept === "missing" ? slept : "reopen";
      }),
    dispose: async (operation: ProvisionOperation) => {
      await publisher.close(proxyId(operation));
      await inTurn(chatId(operation), async () => {
        const current = await store.read(chatId(operation));
        const named = await boxes.find(request(operation).app, boxName(operation));
        for (const sandboxId of new Set([
          ...(current && current.kind !== "asleep" ? [current.sandboxId] : []),
          ...(named ? [named] : []),
        ]))
          if (await boxes.alive(sandboxId)) await boxes.terminate(sandboxId);
        // A memory snapshot cannot be deleted; it expires on its own.
        await store.write(chatId(operation), null);
      });
    },
  };
}
