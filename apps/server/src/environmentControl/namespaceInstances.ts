// @effect-diagnostics nodeBuiltinImport:off - spawnNsc owns the nsc subprocess, its private stdin and token file.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { createClient } from "@namespacelabs/sdk/api";
import {
  type ComputeService,
  InstanceMetadata_Status,
  VolumeRequest_PersistencyKind,
} from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import {
  type ArtifactsService,
  Artifact_Status,
} from "@namespacelabs/sdk/proto/namespace/cloud/storage/v1beta/artifact_pb";
import { LabelFilterEntry_LabelFilterOp } from "@namespacelabs/sdk/proto/namespace/stdlib/labels_pb";
import * as Schema from "effect/Schema";

import { namespaceMacImageSelectors } from "./namespaceAllocation.ts";

export const InstanceId = Schema.String.check(Schema.isMinLength(1)).pipe(
  Schema.brand("NamespaceInstanceId"),
);
export type InstanceId = typeof InstanceId.Type;

/** One running Mac. Its site is observed, never chosen: macOS placement cannot be pinned. */
export const MacIncarnation = Schema.Struct({
  instanceId: InstanceId,
  site: Schema.String,
  createdAt: Schema.Finite,
  /** Epoch ms. Namespace destroys the instance here and never extends past creation + 5h. */
  deadline: Schema.Finite,
});
export type MacIncarnation = typeof MacIncarnation.Type;

/**
 * How an instance leaves, which decides what its cache volume becomes.
 * `commit` is a plain destroy: Namespace makes the volume's state the tag's next
 * parent about 15s later. `abandon` halts the Mac first, which marks that
 * version abandoned, so the tag keeps its previous parent.
 */
export type Departure = "commit" | "abandon";

const isNotFound = Schema.is(Schema.Struct({ code: Schema.Literal(5) }));

/** `nsc` subprocess port. stdin is private and never logged. */
export interface NscCli {
  run(
    args: ReadonlyArray<string>,
    options?: { readonly stdin?: string; readonly timeoutMs?: number },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export function spawnNsc(
  config: { readonly binary?: string; readonly env?: NodeJS.ProcessEnv } = {},
): NscCli {
  return {
    run: (args, options = {}) =>
      new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(config.binary ?? "nsc", [...args], {
          env: config.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let timedOut = false;
        const deadline =
          options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
        const expire = () => {
          timedOut = true;
          child.kill("SIGKILL");
          // A grandchild such as ssh can hold the pipes open past the kill.
          child.stdout.destroy();
          child.stderr.destroy();
        };
        deadline?.addEventListener("abort", expire, { once: true });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (data: string) => {
          stdout += data;
        });
        child.stderr.setEncoding("utf8").on("data", (data: string) => {
          stderr += data;
        });
        child.once("error", (error) => {
          deadline?.removeEventListener("abort", expire);
          reject(error);
        });
        child.once("close", (code) => {
          deadline?.removeEventListener("abort", expire);
          if (timedOut)
            reject(new Error(`nsc ${args[0] ?? ""} timed out after ${options.timeoutMs}ms`));
          else resolve({ exitCode: code ?? 1, stdout, stderr });
        });
        // The child may exit without reading its input.
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin);
      }),
  };
}

/**
 * Runs `nsc` on a private token file per call, so every command acts for the
 * manager's account rather than whatever login the machine has.
 */
export function nscWithToken(config: {
  readonly stateDir: string;
  readonly issueToken: (durationMs: number) => Promise<string>;
  readonly binary?: string;
}): NscCli {
  return {
    run: async (args, options = {}) => {
      await NodeFSP.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      const directory = await NodeFSP.mkdtemp(NodePath.join(config.stateDir, "nsc-"));
      try {
        const tokenFile = NodePath.join(directory, "token.json");
        const token = await config.issueToken(options.timeoutMs ?? 300_000);
        await NodeFSP.writeFile(tokenFile, JSON.stringify({ bearer_token: token }), {
          mode: 0o600,
        });
        return await spawnNsc({
          ...(config.binary ? { binary: config.binary } : {}),
          env: { ...process.env, NSC_TOKEN_FILE: tokenFile },
        }).run(args, options);
      } finally {
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    },
  };
}

type ComputeClient = ReturnType<typeof createClient<typeof ComputeService>>;
type ArtifactsClient = ReturnType<typeof createClient<typeof ArtifactsService>>;
type CallOptions = { readonly timeoutMs?: number };

/** The ComputeService methods this boundary calls. Responses are parsed here, never trusted. */
export interface NamespaceComputeClient {
  createInstance(
    request: Parameters<ComputeClient["createInstance"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  waitInstanceSync(
    request: Parameters<ComputeClient["waitInstanceSync"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  describeInstance(
    request: Parameters<ComputeClient["describeInstance"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  destroyInstance(
    request: Parameters<ComputeClient["destroyInstance"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  listInstances(
    request: Parameters<ComputeClient["listInstances"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  createIngress(
    request: Parameters<ComputeClient["createIngress"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  listIngresses(
    request: Parameters<ComputeClient["listIngresses"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
}

/** The ArtifactsService methods this boundary calls. */
export interface NamespaceArtifactsClient {
  createArtifact(
    request: Parameters<ArtifactsClient["createArtifact"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  finalizeArtifact(
    request: Parameters<ArtifactsClient["finalizeArtifact"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  resolveArtifact(
    request: Parameters<ArtifactsClient["resolveArtifact"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  expireArtifact(
    request: Parameters<ArtifactsClient["expireArtifact"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
  listArtifacts(
    request: Parameters<ArtifactsClient["listArtifacts"]>[0],
    options?: CallOptions,
  ): Promise<unknown>;
}

const WireTimestamp = Schema.Struct({ seconds: Schema.BigInt, nanos: Schema.Number });
const WireInstance = Schema.Struct({
  instanceId: Schema.String,
  createdAt: Schema.optional(WireTimestamp),
  destroyedAt: Schema.optional(WireTimestamp),
  deadline: Schema.optional(WireTimestamp),
  status: Schema.Number,
  ingressDomain: Schema.String,
});
type WireInstance = typeof WireInstance.Type;
const decodeDescribed = Schema.decodeUnknownSync(
  Schema.Struct({ metadata: Schema.optional(WireInstance) }),
);
const decodeInstancePage = Schema.decodeUnknownSync(
  Schema.Struct({ instances: Schema.Array(WireInstance), paginationCursor: Schema.Uint8Array }),
);
const WireArtifact = Schema.Struct({
  path: Schema.String,
  size: Schema.BigInt,
  expiresAt: Schema.optional(WireTimestamp),
});
const decodeCreatedArtifact = Schema.decodeUnknownSync(
  Schema.Struct({ uploadId: Schema.String, signedUploadUrl: Schema.String }),
);
const decodeArtifactDescription = Schema.decodeUnknownSync(
  Schema.Struct({ description: Schema.optional(WireArtifact) }),
);
const decodeResolvedArtifact = Schema.decodeUnknownSync(
  Schema.Struct({
    description: Schema.optional(Schema.Struct({ status: Schema.Number })),
    signedDownloadUrl: Schema.String,
  }),
);
const decodeArtifactPage = Schema.decodeUnknownSync(
  Schema.Struct({ artifacts: Schema.Array(WireArtifact), paginationCursor: Schema.Uint8Array }),
);
const decodeIngresses = Schema.decodeUnknownSync(
  Schema.Struct({
    allocatedIngresses: Schema.Array(Schema.Struct({ name: Schema.String, fqdn: Schema.String })),
  }),
);
const decodeIncarnation = Schema.decodeUnknownSync(MacIncarnation);
const decodeInstanceId = Schema.decodeUnknownSync(InstanceId);

const macShapes = {
  m: { virtualCpu: 6, memoryMegabytes: 14_336 },
  l: { virtualCpu: 12, memoryMegabytes: 28_672 },
};

const toEpochMs = (timestamp: typeof WireTimestamp.Type) =>
  Number(timestamp.seconds) * 1000 + Math.floor(timestamp.nanos / 1_000_000);
const toTimestamp = (epochMs: number) => {
  const ms = Math.floor(epochMs);
  return { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
};
const wireLabels = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([name, value]) => ({ name, value }));
/** An empty filter matches every resource in the account, which no caller means. */
const labelFilter = (labels: Readonly<Record<string, string>>) => {
  const entries = Object.entries(labels);
  if (entries.length === 0) throw new Error("A Namespace label query needs at least one label");
  return entries.map(([name, value]) => ({
    name,
    value,
    op: LabelFilterEntry_LabelFilterOp.EQUAL,
  }));
};
/** Pages until the server returns an empty cursor. */
async function collectPages<T>(
  fetchPage: (
    cursor: Uint8Array,
  ) => Promise<{ readonly items: ReadonlyArray<T>; readonly cursor: Uint8Array }>,
) {
  const items: T[] = [];
  let cursor: Uint8Array = new Uint8Array();
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor.length > 0);
  return items;
}
const privateHttps = (raw: string) => {
  const url = URL.parse(raw);
  if (!url || url.protocol !== "https:" || url.username || url.password)
    throw new Error("Namespace returned a signed URL that is not private HTTPS");
  return url.href;
};
const shellQuote = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

const isGone = (wire: WireInstance) =>
  wire.destroyedAt !== undefined ||
  wire.status === InstanceMetadata_Status.DESTROYED ||
  wire.status === InstanceMetadata_Status.DESTROYING;

function toIncarnation(wire: WireInstance): MacIncarnation {
  if (!wire.deadline) throw new Error(`Namespace instance ${wire.instanceId} has no deadline`);
  if (!wire.createdAt)
    throw new Error(`Namespace instance ${wire.instanceId} has no creation time`);
  // The ingress domain is "<site>.nscluster.cloud"; macOS placement only reports its site here.
  // The site is diagnostic, so an instance still being placed lists rather than failing a sweep.
  const site = /^([a-z][a-z0-9-]*)\./.exec(wire.ingressDomain)?.[1] ?? "unplaced";
  return decodeIncarnation({
    instanceId: wire.instanceId,
    site,
    createdAt: toEpochMs(wire.createdAt),
    deadline: toEpochMs(wire.deadline),
  });
}

export interface MacInstanceSpec {
  readonly labels: Readonly<Record<string, string>>;
  readonly cache: {
    readonly tag: string;
    readonly mountPoint: string;
    readonly sizeGb: number;
  } | null;
  /** Epoch ms. */
  readonly deadline: number;
  readonly size: "m" | "l";
  readonly purpose: string;
}

export interface NamespaceInstances {
  /** Creates a Mac and returns once Namespace reports it ready. */
  create(spec: MacInstanceSpec): Promise<MacIncarnation>;
  /** Null once destroyed or never known to Namespace. */
  describe(instanceId: InstanceId): Promise<MacIncarnation | null>;
  /** Live instances carrying every given label. */
  list(labels: Readonly<Record<string, string>>): Promise<ReadonlyArray<MacIncarnation>>;
  /** Runs argv on the Mac. stdin travels over the ssh channel, never in argv. */
  exec(
    instanceId: InstanceId,
    argv: ReadonlyArray<string>,
    options?: { readonly stdin?: string; readonly timeoutMs?: number },
  ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  /** The single exit for an instance. Departing a gone instance succeeds. */
  depart(instanceId: InstanceId, departure: Departure): Promise<void>;
  /**
   * The HTTPS origin Namespace serves a guest port on. Reached only with the tenant's
   * `x-nsc-ingress-auth` bearer, so the manager's proxy is the only way in.
   */
  expose(instanceId: InstanceId, port: number): Promise<string>;
  /** Copies a manager file onto the Mac. The SDK has no upload call, so this is `nsc`. */
  upload(instanceId: InstanceId, localPath: string, guestPath: string): Promise<void>;
}

export function makeNamespaceInstances(config: {
  readonly compute: NamespaceComputeClient;
  readonly nsc: NscCli;
}): NamespaceInstances {
  const { compute, nsc } = config;
  const describe = async (instanceId: InstanceId) => {
    const response = await compute
      .describeInstance({ instanceId }, { timeoutMs: 30_000 })
      .catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
    if (response === null) return null;
    const { metadata } = decodeDescribed(response);
    if (metadata?.instanceId !== instanceId)
      throw new Error(`Namespace did not describe instance ${instanceId}`);
    return isGone(metadata) ? null : toIncarnation(metadata);
  };
  const exec: NamespaceInstances["exec"] = (instanceId, argv, options) =>
    nsc.run(["ssh", "-T", instanceId, "--", argv.map(shellQuote).join(" ")], options);
  return {
    create: async (spec) => {
      const created = decodeDescribed(
        await compute.createInstance(
          {
            shape: {
              os: "macos",
              machineArch: "arm64",
              ...macShapes[spec.size],
              selectors: namespaceMacImageSelectors,
            },
            documentedPurpose: spec.purpose,
            labels: wireLabels(spec.labels),
            deadline: toTimestamp(spec.deadline),
            placement: ["continent:us"],
            volumes: spec.cache
              ? [
                  {
                    tag: spec.cache.tag,
                    mountPoint: spec.cache.mountPoint,
                    sizeMb: BigInt(spec.cache.sizeGb * 1024),
                    persistencyKind: VolumeRequest_PersistencyKind.CACHE,
                  },
                ]
              : [],
          },
          { timeoutMs: 120_000 },
        ),
      );
      if (!created.metadata?.instanceId)
        throw new Error("Namespace createInstance returned no instance id");
      const instanceId = decodeInstanceId(created.metadata.instanceId);
      await compute.waitInstanceSync({ instanceId }, { timeoutMs: 15 * 60_000 });
      const ready = await describe(instanceId);
      if (ready === null)
        throw new Error(`Namespace instance ${instanceId} was destroyed before it became ready`);
      return ready;
    },
    describe,
    list: async (labels) => {
      const filter = labelFilter(labels);
      const instances = await collectPages(async (paginationCursor) => {
        const page = decodeInstancePage(
          await compute.listInstances(
            { labelFilter: filter, paginationCursor },
            { timeoutMs: 30_000 },
          ),
        );
        return { items: page.instances, cursor: page.paginationCursor };
      });
      return instances.filter((wire) => !isGone(wire)).map(toIncarnation);
    },
    exec,
    expose: async (instanceId, port) => {
      const name = `t3-${port}`;
      const listed = decodeIngresses(
        await compute.listIngresses({ instanceId }, { timeoutMs: 30_000 }),
      ).allocatedIngresses.find((ingress) => ingress.name === name);
      const fqdn =
        listed?.fqdn ??
        decodeIngresses(
          await compute.createIngress(
            {
              instanceId,
              ingresses: [{ name, exportedPortBackend: { port }, httpMatchRule: [] }],
            },
            { timeoutMs: 60_000 },
          ),
        ).allocatedIngresses.find((ingress) => ingress.name === name)?.fqdn;
      if (!fqdn)
        throw new Error(`Namespace allocated no ingress for port ${port} on ${instanceId}`);
      return privateHttps(`https://${fqdn}`).replace(/\/$/, "");
    },
    upload: async (instanceId, localPath, guestPath) => {
      const result = await nsc.run(["instance", "upload", instanceId, localPath, guestPath], {
        timeoutMs: 15 * 60_000,
      });
      if (result.exitCode !== 0)
        throw new Error(
          `nsc instance upload failed: ${(result.stderr || result.stdout).trim().slice(-500)}`,
        );
    },
    depart: async (instanceId, departure) => {
      // Halting before the destroy marks the cache version abandoned, so the tag keeps
      // its parent. The result is ignored: ssh drops as the Mac halts.
      if (departure === "abandon")
        await exec(instanceId, ["sudo", "-n", "shutdown", "-h", "now"], {
          timeoutMs: 60_000,
        }).catch(() => undefined);
      await compute
        .destroyInstance({ instanceId, reason: `t3 ${departure}` }, { timeoutMs: 60_000 })
        .catch(async (error: unknown) => {
          if (isNotFound(error) || (await describe(instanceId)) === null) return;
          throw error;
        });
    },
  };
}

export interface NamespaceArtifacts {
  /** The caller PUTs the bytes to the signed URL, then finalizes. */
  beginUpload(input: {
    readonly path: string;
    /** Epoch ms. */
    readonly expiresAt: number;
    readonly labels: Readonly<Record<string, string>>;
  }): Promise<{ readonly uploadId: string; readonly signedUploadUrl: string }>;
  finalize(uploadId: string): Promise<{ readonly path: string; readonly bytes: number }>;
  downloadUrl(path: string): Promise<string>;
  /** Expiring an expired or unknown artifact succeeds. */
  expire(path: string): Promise<void>;
  /** Live artifacts carrying every given label. */
  list(labels: Readonly<Record<string, string>>): Promise<
    ReadonlyArray<{
      readonly path: string;
      readonly bytes: number;
      /** Epoch ms, or null when the artifact never expires. */
      readonly expiresAt: number | null;
    }>
  >;
}

export function makeNamespaceArtifacts(config: {
  readonly artifacts: NamespaceArtifactsClient;
}): NamespaceArtifacts {
  const { artifacts } = config;
  const namespace = "main";
  const isExpired = async (path: string) => {
    const response = await artifacts
      .resolveArtifact(
        { namespace, path, metadataOnly: true, includeExpired: true },
        { timeoutMs: 30_000 },
      )
      .catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
    return (
      response === null ||
      decodeResolvedArtifact(response).description?.status === Artifact_Status.EXPIRED
    );
  };
  return {
    beginUpload: async ({ path, expiresAt, labels }) => {
      const { uploadId, signedUploadUrl } = decodeCreatedArtifact(
        await artifacts.createArtifact(
          { namespace, path, expiresAt: toTimestamp(expiresAt), labels: wireLabels(labels) },
          { timeoutMs: 30_000 },
        ),
      );
      if (!uploadId) throw new Error(`Namespace createArtifact returned no upload id for ${path}`);
      return { uploadId, signedUploadUrl: privateHttps(signedUploadUrl) };
    },
    finalize: async (uploadId) => {
      const { description } = decodeArtifactDescription(
        await artifacts.finalizeArtifact({ namespace, uploadId }, { timeoutMs: 60_000 }),
      );
      if (!description)
        throw new Error(`Namespace finalizeArtifact returned no artifact for upload ${uploadId}`);
      return { path: description.path, bytes: Number(description.size) };
    },
    downloadUrl: async (path) => {
      const { signedDownloadUrl } = decodeResolvedArtifact(
        await artifacts.resolveArtifact({ namespace, path }, { timeoutMs: 30_000 }),
      );
      return privateHttps(signedDownloadUrl);
    },
    expire: async (path) => {
      await artifacts
        .expireArtifact({ namespace, path }, { timeoutMs: 30_000 })
        .catch(async (error: unknown) => {
          if (isNotFound(error) || (await isExpired(path))) return;
          throw error;
        });
    },
    list: async (labels) => {
      const filter = labelFilter(labels);
      const found = await collectPages(async (paginationCursor) => {
        const page = decodeArtifactPage(
          await artifacts.listArtifacts(
            { namespaces: [namespace], labelFilter: filter, skipExpired: true, paginationCursor },
            { timeoutMs: 30_000 },
          ),
        );
        return { items: page.artifacts, cursor: page.paginationCursor };
      });
      return found.map((artifact) => ({
        path: artifact.path,
        bytes: Number(artifact.size),
        expiresAt: artifact.expiresAt ? toEpochMs(artifact.expiresAt) : null,
      }));
    },
  };
}
