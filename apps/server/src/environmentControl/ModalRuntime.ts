// @effect-diagnostics globalDate:off - Modal deadlines and snapshot ages are wall-clock times at the SDK boundary.
// @effect-diagnostics nodeBuiltinImport:off - the Promise box API backs off between Modal SDK retries outside Effect.
import * as NodeTimersPromises from "node:timers/promises";
import {
  InternalFailure,
  ModalClient,
  NotFoundError,
  ResourceExhaustedError,
  type Sandbox,
} from "modal";
import type { ProvisionOperation } from "@t3tools/contracts";

import type { ProvisionRuntimeArtifact } from "./config.ts";
import { ProvisionedSandboxMissing } from "./driver.ts";
import { backUpBox } from "./boxBackup.ts";
import { readBoxHealth } from "./boxHealth.ts";
import { GUEST_INIT_SOCKET, guestInitScript } from "./guestInit.ts";
import { withGuestProviderInstall } from "./guestProviderInstall.ts";
import { makeModalChatStore, type ModalChatRecord, type ModalDiskSave } from "./modalChatStore.ts";
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
/** Why a chat booted fresh from its disk, as its agent is told: "...because <why>". */
const EXPIRED = "Modal keeps a sleeping machine's memory for only seven days";
const LOST = "Modal ended the machine without saving its memory";
const DROPPED = "it was paused without its memory";
const PREPARE_TIMEOUT_MS = 1_200_000;
/**
 * How guest scripts run: as root, Modal's user, since gVisor sets no_new_privs and only root's
 * sudo works there, in the E2B template's home. Claude Code bypasses permissions as root only
 * when told it runs in a sandbox, and the T3 server and its agents inherit that.
 */
export const MODAL_GUEST_ENV = [
  "env",
  "HOME=/home/user",
  "USER=root",
  "LOGNAME=root",
  "IS_SANDBOX=1",
];

export interface ModalBoxSpec {
  readonly app: string;
  readonly environment?: string;
  readonly name: string;
  readonly imageId: string;
  /** Absent, gVisor, Modal's default. */
  readonly runtime?: "vm";
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
  readonly inboundCidrs?: ReadonlyArray<string>;
}

/** A throwaway box booted from a disk image: no name, no memory snapshots, gone at its timeout. */
export type ModalCopySpec = Omit<ModalBoxSpec, "name" | "port">;

/** What the runtime asks of Modal. Every sandbox of a chat carries the chat's name. */
export interface ModalBoxes {
  /** The running sandbox named `name`, if any. */
  readonly find: (app: string, name: string, environment?: string) => Promise<string | null>;
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
  readonly download: (sandboxId: string, remotePath: string, localPath: string) => Promise<void>;
  /**
   * A filesystem snapshot of a running sandbox, kept `ttlMs` or, when null, until deleted. The
   * sandbox keeps running through it.
   */
  readonly saveDisk: (sandboxId: string, ttlMs: number | null) => Promise<string>;
  /** Deletes a disk image; one a running sandbox booted from keeps working. */
  readonly deleteImage: (imageId: string) => Promise<void>;
  readonly createCopy: (spec: ModalCopySpec) => Promise<string>;
  /** The running sandboxes of `app` that carry every one of `tags`. */
  readonly list: (
    app: string,
    environment: string | undefined,
    tags: Readonly<Record<string, string>>,
  ) => Promise<
    ReadonlyArray<{ readonly sandboxId: string; readonly tags: Record<string, string> }>
  >;
}

const cidr = /^[0-9.:a-fA-F]+(?:\/\d+)?$/;

/**
 * Retries a call Modal refused for capacity, quota or a fault of its own, which a create meets
 * while it waits to be scheduled. Any other failure is the caller's.
 */
async function transient<A>(call: () => Promise<A>, attempts = 4): Promise<A> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      const retryable = error instanceof ResourceExhaustedError || error instanceof InternalFailure;
      if (!retryable || attempt >= attempts) throw error;
      await NodeTimersPromises.setTimeout(2_000 * 2 ** (attempt - 1));
    }
  }
}

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
    find: async (app, name, environment) => {
      try {
        const sandbox = await modal.sandboxes.fromName(
          app,
          name,
          environment ? { environment } : {},
        );
        return (await isRunning(sandbox)) ? sandbox.sandboxId : null;
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
    create: async (spec) => {
      const app = await modal.apps.fromName(spec.app, {
        createIfMissing: true,
        ...(spec.environment ? { environment: spec.environment } : {}),
      });
      const image = await modal.images.fromId(spec.imageId);
      try {
        const sandbox = await transient(() =>
          modal.sandboxes.create(app, image, {
            name: spec.name,
            ...(spec.runtime ? { runtime: spec.runtime } : {}),
            // A snapshot keeps the entrypoint's descendants, so the entrypoint starts the box's
            // long-lived processes and a chat sleeps without a restart.
            command: ["python3", "-c", guestInitScript, GUEST_INIT_SOCKET],
            experimentalEnableSnapshot: true,
            encryptedPorts: [spec.port],
            timeoutMs: spec.timeoutMs,
            ...spec.sizing,
            tags: { ...spec.tags },
            ...(spec.egress.domains.length
              ? { outboundDomainAllowlist: [...spec.egress.domains] }
              : {}),
            ...(spec.egress.cidrs.length ? { outboundCidrAllowlist: [...spec.egress.cidrs] } : {}),
            ...(spec.inboundCidrs?.length ? { inboundCidrAllowlist: [...spec.inboundCidrs] } : {}),
          }),
        );
        return sandbox.sandboxId;
      } catch (error) {
        if (nameTaken(error)) return "exists";
        throw error;
      }
    },
    restore: async (snapshotId) => {
      try {
        const snapshot = await modal.sandboxSnapshots.fromId(snapshotId);
        return (await transient(() => modal.sandboxes.experimentalFromSnapshot(snapshot)))
          .sandboxId;
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
    // Waits until the sandbox has ended, since its name stays taken until then.
    terminate: async (sandboxId) => void (await (await box(sandboxId)).terminate({ wait: true })),
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
      const chmod = await sandbox.exec(["chmod", "0644", remotePath], { timeoutMs: 60_000 });
      if ((await chmod.wait()) !== 0) throw new Error("The runtime archive could not be shared");
    },
    download: async (sandboxId, remotePath, localPath) =>
      (await box(sandboxId)).filesystem.copyToLocal(remotePath, localPath),
    saveDisk: async (sandboxId, ttlMs) =>
      (
        await transient(async () =>
          (await box(sandboxId)).snapshotFilesystem({ timeoutMs: 300_000, ttlMs }),
        )
      ).imageId,
    deleteImage: async (imageId) => {
      try {
        await modal.images.delete(imageId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    },
    createCopy: async (spec) => {
      const app = await modal.apps.fromName(
        spec.app,
        spec.environment ? { environment: spec.environment } : {},
      );
      const sandbox = await transient(async () =>
        modal.sandboxes.create(app, await modal.images.fromId(spec.imageId), {
          ...(spec.runtime ? { runtime: spec.runtime } : {}),
          command: ["sleep", "infinity"],
          timeoutMs: spec.timeoutMs,
          ...spec.sizing,
          tags: { ...spec.tags },
          ...(spec.egress.domains.length
            ? { outboundDomainAllowlist: [...spec.egress.domains] }
            : {}),
          ...(spec.egress.cidrs.length ? { outboundCidrAllowlist: [...spec.egress.cidrs] } : {}),
        }),
      );
      return sandbox.sandboxId;
    },
    list: async (appName, environment, tags) => {
      const app = await modal.apps.fromName(appName, environment ? { environment } : {});
      const found: Array<{ sandboxId: string; tags: Record<string, string> }> = [];
      for await (const sandbox of modal.sandboxes.experimentalList({
        appId: app.appId,
        tags: { ...tags },
        ...(environment ? { environment } : {}),
      }))
        found.push({ sandboxId: sandbox.sandboxId, tags: await sandbox.getTags() });
      return found;
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
  /**
   * Each chat's step in flight. A host that rebuilds the runtime on a config change passes the
   * one map it keeps, so a step on the old runtime still orders the next one on the new.
   */
  readonly turns?: Map<string, Promise<unknown>>;
  /** Each chat's guest work outside its steps, kept across rebuilt runtimes as `turns` is. */
  readonly work?: Map<string, Set<Promise<unknown>>>;
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
  const turns = config.turns ?? new Map<string, Promise<unknown>>();
  const inTurn = <A>(chatId: string, run: () => Promise<A>): Promise<A> => {
    const result = (turns.get(chatId) ?? Promise.resolve()).then(run);
    const settled = result.catch(() => undefined);
    turns.set(chatId, settled);
    void settled.then(() => {
      if (turns.get(chatId) === settled) turns.delete(chatId);
    });
    return result;
  };
  const work = config.work ?? new Map<string, Set<Promise<unknown>>>();
  /**
   * Runs guest work beside a chat's steps, such as a backup, which must not hold up a wake. Modal
   * refuses a memory snapshot while an exec runs, so a sleep marks the chat `saving` and then
   * waits for this work; work that starts after the mark finds the chat not awake and does nothing.
   */
  const alongside = <A>(chatId: string, run: () => Promise<A>): Promise<A> => {
    const running = work.get(chatId) ?? new Set();
    work.set(chatId, running);
    const result = Promise.resolve().then(run);
    const settled = result.catch(() => undefined);
    running.add(settled);
    void settled.then(() => {
      running.delete(settled);
      if (running.size === 0 && work.get(chatId) === running) work.delete(chatId);
    });
    return result;
  };
  const settle = (chatId: string) => Promise.all(work.get(chatId) ?? []);
  const request = (operation: ProvisionOperation) => {
    if (operation.request.provider !== "modal") throw new Error("Not a Modal chat");
    return operation.request;
  };
  const chatId = (operation: ProvisionOperation) => operation.request.requestId;
  const boxName = (operation: ProvisionOperation) => `t3-chat-${chatId(operation)}`;
  const proxyId = (operation: ProvisionOperation) => `provision-${chatId(operation)}`;
  const expired = (chainStartedAt: number | null) =>
    chainStartedAt !== null && now() - chainStartedAt >= SNAPSHOT_LIFETIME_MS;

  /** Guest scripts on a box, each ended by `deadline` when one is given. */
  const guestPort = (sandboxId: string, deadline?: number): RemotePreparationPort => ({
    executePython: ({ script, stdin }) =>
      boxes.exec(sandboxId, [...MODAL_GUEST_ENV, "python3", "-c", script], {
        stdin,
        timeoutMs:
          deadline === undefined ? PREPARE_TIMEOUT_MS : Math.max(1_000, deadline - Date.now()),
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

  /** Starts a chat's box: from its image for its first, from a disk save for a fresh boot. */
  const createBox = async (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    imageId: string,
  ) => {
    const modal = request(operation);
    const id = chatId(operation);
    const created = await boxes.create({
      app: modal.app,
      ...(modal.environment ? { environment: modal.environment } : {}),
      name: boxName(operation),
      imageId,
      port: manifest.preparation.port,
      timeoutMs: retentionTimeoutMs(operation.request.retentionDeadline, BOX_LIFETIME_MS),
      ...(modal.runtime ? { runtime: modal.runtime } : {}),
      sizing: modal.sizing,
      tags: {
        provision_request_id: id,
        preparation_hash: operation.request.preparationHash,
        account: operation.request.providerInstanceId,
      },
      egress: modalEgress(manifest.egressAllow),
      ...(modal.inboundCidrs ? { inboundCidrs: modal.inboundCidrs } : {}),
    });
    const sandboxId =
      created === "exists"
        ? await boxes.find(modal.app, boxName(operation), modal.environment)
        : created;
    if (sandboxId === null) throw new Error("The Modal box named for this chat could not be found");
    return sandboxId;
  };

  /**
   * The running sandbox of the chat, after waking it from its snapshot or creating its first
   * one. A sandbox already carrying the chat's name is adopted, which is what a step a crash cut
   * off left behind. A chat whose memory is gone boots fresh from its latest disk save, and
   * `freshBoot` says why; with no disk save it is missing.
   */
  const awake = async (
    operation: ProvisionOperation,
    manifest: ProvisionPreparationManifest,
    record?: RecordProvisionPhase,
  ): Promise<{ readonly sandboxId: string; readonly freshBoot?: string }> => {
    const modal = request(operation);
    const id = chatId(operation);
    const current = await store.read(id);
    const fromDisk = async (disk: ModalDiskSave | undefined, why: string) => {
      if (!disk) throw new ProvisionedSandboxMissing();
      const stop = startProvisionPhase(record);
      const sandboxId = await createBox(operation, manifest, disk.imageId);
      stop("modal.freshBoot");
      await store.write(id, {
        kind: "awake",
        sandboxId,
        startedAt: now(),
        chainStartedAt: null,
        disk,
      });
      log("modal chat booted fresh from its disk", { chatId: id, sandboxId, why });
      return { sandboxId, freshBoot: why };
    };
    if (current?.kind === "awake" || current?.kind === "saving") {
      if (await boxes.alive(current.sandboxId)) {
        if (current.kind === "saving") await store.write(id, { ...current, kind: "awake" });
        return { sandboxId: current.sandboxId };
      }
      // Modal ended it without a snapshot this manager recorded. A box that died before its chat
      // was ever ready held nothing, so its preparation starts over on a new one.
      if (
        current.kind === "saving" ||
        current.chainStartedAt !== null ||
        operation.state.kind === "ready"
      )
        return fromDisk(current.disk, LOST);
    }
    if (current?.kind === "stopped") return fromDisk(current.disk, current.reason);
    if (current?.kind === "asleep") {
      if (expired(current.chainStartedAt)) return fromDisk(current.disk, EXPIRED);
      const stop = startProvisionPhase(record);
      const restored = await boxes.restore(current.snapshotId);
      const sandboxId =
        restored === "exists"
          ? await boxes.find(modal.app, boxName(operation), modal.environment)
          : restored;
      if (sandboxId === null || sandboxId === "expired") return fromDisk(current.disk, EXPIRED);
      stop("modal.restore");
      await store.write(id, {
        kind: "awake",
        sandboxId,
        startedAt: now(),
        chainStartedAt: current.chainStartedAt,
        ...(current.disk ? { disk: current.disk } : {}),
      });
      log("modal chat restored", { chatId: id, sandboxId });
      return { sandboxId };
    }
    const stop = startProvisionPhase(record);
    const sandboxId = await createBox(operation, manifest, modal.imageId);
    stop("modal.create");
    await store.write(id, { kind: "awake", sandboxId, startedAt: now(), chainStartedAt: null });
    log("modal chat created", { chatId: id, sandboxId });
    return { sandboxId };
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
    // Started before the entrypoint listens, the server would run outside it and stop for good
    // at the box's first snapshot.
    const listening = await boxes.exec(
      sandboxId,
      [
        "sh",
        "-c",
        'for _ in $(seq 300); do [ -S "$1" ] && exit 0; sleep 0.1; done; exit 1',
        "sh",
        GUEST_INIT_SOCKET,
      ],
      { timeoutMs: 60_000 },
    );
    if (listening.exitCode !== 0) throw new Error("The Modal box's entrypoint is not listening");
    const stopPresence = startProvisionPhase(record);
    const staged = await boxes.exec(
      sandboxId,
      [
        ...MODAL_GUEST_ENV,
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

  /** Deletes a disk save once a newer one is recorded. One that cannot be deleted is logged. */
  const dropDisk = async (disk: ModalDiskSave) =>
    boxes
      .deleteImage(disk.imageId)
      .catch((cause: unknown) =>
        log("modal disk save could not be deleted", { imageId: disk.imageId, cause }),
      );
  const diskSaves = new Map<string, Promise<ModalDiskSave | null>>();
  /**
   * Saves an awake chat's disk as its latest save, replacing the one before, and answers it; null
   * when the chat is not awake. A save already running for the chat is joined.
   */
  const saveDisk = (id: string): Promise<ModalDiskSave | null> => {
    const running = diskSaves.get(id);
    if (running) return running;
    const saving = alongside(id, async () => {
      const current = await store.read(id);
      if (current?.kind !== "awake" || !(await boxes.alive(current.sandboxId))) return null;
      const at = now();
      const disk = { imageId: await boxes.saveDisk(current.sandboxId, null), at };
      const latest = await store.read(id);
      if (
        (latest?.kind !== "awake" && latest?.kind !== "saving") ||
        latest.sandboxId !== current.sandboxId
      ) {
        await dropDisk(disk);
        return null;
      }
      await store.write(id, { ...latest, disk });
      if (latest.disk && latest.disk.imageId !== disk.imageId) await dropDisk(latest.disk);
      log("modal chat disk saved", { chatId: id, durationMs: now() - at });
      return disk;
    }).finally(() => diskSaves.delete(id));
    diskSaves.set(id, saving);
    return saving;
  };

  /** A chat whose box Modal ended while it was awake sleeps on its disk save, if it has one. */
  const lost = async (id: string, disk: ModalDiskSave | undefined): Promise<ChatOutcome> => {
    if (!disk) return "missing";
    await store.write(id, { kind: "stopped", disk, reason: LOST });
    return "released";
  };

  /**
   * Snapshots an awake chat's memory, which ends its box, and never forgets the box before the
   * snapshot is recorded. With `keepMemory` false the box's disk is saved and the box ended
   * instead, so it wakes as a fresh boot.
   */
  const sleep = async (operation: ProvisionOperation, keepMemory = true): Promise<ChatOutcome> => {
    const id = chatId(operation);
    const current = await store.read(id);
    if (current === null) return "missing";
    if (current.kind === "stopped") return "released";
    if (current.kind === "asleep")
      return expired(current.chainStartedAt) && !current.disk ? "missing" : "released";
    if (!(await boxes.alive(current.sandboxId))) return lost(id, current.disk);
    await store.write(id, { ...current, kind: "saving" });
    await settle(id);
    // A disk save that finished while this waited recorded itself on the `saving` record.
    const latest = await store.read(id);
    const disk = latest?.kind === "saving" ? latest.disk : current.disk;
    const started = now();
    if (!keepMemory) {
      const saved = { imageId: await boxes.saveDisk(current.sandboxId, null), at: started };
      await boxes.terminate(current.sandboxId);
      await store.write(id, { kind: "stopped", disk: saved, reason: DROPPED });
      if (disk) await dropDisk(disk);
      log("modal chat stopped on its disk", { chatId: id, durationMs: now() - started });
      return "released";
    }
    const snapshotId = await boxes.snapshot(current.sandboxId);
    await store.write(id, {
      kind: "asleep",
      snapshotId,
      chainStartedAt: current.chainStartedAt ?? started,
      ...(disk ? { disk } : {}),
    });
    log("modal chat snapshotted", { chatId: id, durationMs: now() - started });
    return "released";
  };

  /** The awake chat's running box, or null; work beside its steps runs only on one. */
  const runningBox = async (id: string) => {
    const current = await store.read(id);
    return current?.kind === "awake" && (await boxes.alive(current.sandboxId))
      ? current.sandboxId
      : null;
  };

  return {
    /** Modal itself, for the throwaway copies a chat's forks run on. */
    boxes,
    prepare: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      record?: RecordProvisionPhase,
      build: ProvisionRuntimeArtifact | null = null,
    ) =>
      inTurn(chatId(operation), async () => {
        const { sandboxId } = await awake(operation, manifest, record);
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
    /**
     * Wakes a chat at the origin its client saved, starting its T3 server again if it is down.
     * `freshBoot` says why a chat whose memory was gone booted fresh from its disk.
     */
    resume: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      build: ProvisionRuntimeArtifact | null = null,
    ) =>
      inTurn(chatId(operation), async () => {
        const { sandboxId, freshBoot } = await awake(operation, manifest);
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
          ...(freshBoot ? { freshBoot } : {}),
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
    release: (operation: ProvisionOperation, keepMemory?: false) =>
      inTurn(chatId(operation), () => sleep(operation, keepMemory ?? true)),
    touch: (operation: ProvisionOperation) =>
      inTurn(chatId(operation), async (): Promise<"running" | ChatOutcome> => {
        const current = await store.read(chatId(operation));
        if (current === null) return "missing";
        if (current.kind === "stopped") return "released";
        if (current.kind === "asleep")
          return expired(current.chainStartedAt) && !current.disk ? "missing" : "released";
        if (await boxes.alive(current.sandboxId)) return "running";
        return current.disk ? "released" : "missing";
      }),
    /**
     * One upkeep pass for an awake chat: a box nearing Modal's lifetime cap is snapshotted, an
     * idle one to sleep and a busy one to be woken again on a new box.
     */
    upkeep: (operation: ProvisionOperation, idle: () => Promise<boolean>) =>
      inTurn(chatId(operation), async (): Promise<"kept" | "reopen" | ChatOutcome> => {
        const id = chatId(operation);
        const current: ModalChatRecord | null = await store.read(id);
        if (current === null) return "missing";
        if (current.kind === "stopped") return "reopen";
        if (current.kind === "asleep")
          return expired(current.chainStartedAt) && !current.disk ? "missing" : "reopen";
        if (!(await boxes.alive(current.sandboxId))) return lost(id, current.disk);
        const age = now() - current.startedAt;
        if (age < ROTATE_IDLE_MS) return "kept";
        const asleep = await idle();
        if (!asleep && age < ROTATE_FORCE_MS) return "kept";
        log("modal chat rotated before its lifetime cap", { chatId: id, age, asleep });
        const slept = await sleep(operation);
        return asleep || slept === "missing" ? slept : "reopen";
      }),
    /**
     * Backs an awake chat up by `deadline`: its disk, which a fresh boot starts from, and its
     * work and sessions as an E2B box's are (see boxBackup). Null when it is not awake.
     */
    backUp: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      input: Omit<Parameters<typeof backUpBox>[1], "root" | "deadline">,
      deadline: number,
    ) =>
      alongside(chatId(operation), async () => {
        const sandboxId = await runningBox(chatId(operation));
        if (sandboxId === null) return null;
        const [disk, work] = await Promise.allSettled([
          saveDisk(chatId(operation)),
          backUpBox(guestPort(sandboxId, deadline), {
            ...input,
            root: manifest.preparation.root,
            deadline,
          }),
        ]);
        if (work.status === "rejected") throw work.reason;
        if (disk.status === "fulfilled") return work.value;
        const reason = disk.reason instanceof Error ? disk.reason.message : String(disk.reason);
        return {
          ...work.value,
          problems: [...work.value.problems, `The box's disk could not be saved: ${reason}`],
        };
      }),
    /**
     * Whether an awake chat's box answers a trivial command; null when it is not awake. Modal
     * gives no metrics for a sandbox, so a box is never found pinned.
     */
    probeHealth: (operation: ProvisionOperation) =>
      alongside(chatId(operation), async () => {
        const sandboxId = await runningBox(chatId(operation));
        if (sandboxId === null) return null;
        return readBoxHealth({
          answered: boxes.exec(sandboxId, ["true"], { timeoutMs: 10_000 }),
          samples: async () => [],
        });
      }),
    /**
     * Saves an awake chat's disk for its forks, kept `ttlMs`, with what its copies start with;
     * null when it is not awake.
     */
    captureForForks: (
      operation: ProvisionOperation,
      manifest: ProvisionPreparationManifest,
      ttlMs: number,
    ) =>
      alongside(chatId(operation), async () => {
        const sandboxId = await runningBox(chatId(operation));
        if (sandboxId === null) return null;
        const modal = request(operation);
        const copy: Omit<ModalCopySpec, "imageId" | "timeoutMs" | "tags"> = {
          app: modal.app,
          ...(modal.environment ? { environment: modal.environment } : {}),
          ...(modal.runtime ? { runtime: modal.runtime } : {}),
          sizing: modal.sizing,
          egress: modalEgress(manifest.egressAllow),
        };
        return { imageId: await boxes.saveDisk(sandboxId, ttlMs), copy };
      }),
    /** Unpacks a local .tgz into an awake chat's box at `destination`; "asleep" when it is not awake. */
    unpackInto: (operation: ProvisionOperation, archive: string, destination: string) =>
      alongside(chatId(operation), async () => {
        const sandboxId = await runningBox(chatId(operation));
        if (sandboxId === null) return "asleep" as const;
        await boxes.upload(sandboxId, archive, `${destination}.tgz`);
        const unpacked = await boxes.exec(
          sandboxId,
          [
            ...MODAL_GUEST_ENV,
            "sh",
            "-c",
            'mkdir -p "$1" && tar -xzf "$1.tgz" -C "$1" && rm -f "$1.tgz"',
            "sh",
            destination,
          ],
          { timeoutMs: 600_000 },
        );
        if (unpacked.exitCode !== 0)
          throw new Error(`The outputs could not be unpacked: ${unpacked.stderr.slice(-500)}`);
        return "copied" as const;
      }),
    /** Guest scripts on an awake chat's box, as a rebuild restores a backup through them. */
    guest: async (operation: ProvisionOperation) => guestPort(await awakeBox(operation)),
    dispose: async (operation: ProvisionOperation) => {
      await publisher.close(proxyId(operation));
      await inTurn(chatId(operation), async () => {
        const id = chatId(operation);
        await settle(id);
        const current = await store.read(id);
        const { app, environment } = request(operation);
        const named = await boxes.find(app, boxName(operation), environment);
        for (const sandboxId of new Set([
          ...(current?.kind === "awake" || current?.kind === "saving" ? [current.sandboxId] : []),
          ...(named ? [named] : []),
        ]))
          if (await boxes.alive(sandboxId)) await boxes.terminate(sandboxId);
        // A memory snapshot cannot be deleted; it expires on its own.
        if (current?.disk) await dropDisk(current.disk);
        await store.write(id, null);
      });
    },
  };
}
