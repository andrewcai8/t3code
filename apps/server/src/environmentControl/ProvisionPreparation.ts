// @effect-diagnostics nodeBuiltinImport:off - immutable private inputs are captured at the filesystem and provider boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import {
  DEFAULT_SERVER_SETTINGS,
  DurableProvisionRequest,
  defaultInstanceIdForDriver,
  EnvironmentProvisionInput,
  ProviderDriverKind,
  ProvisionProvider,
  ProvisionRequestConflict,
  type ProvisionRequestId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { resolveNamespaceIdentity, namespaceMacImage } from "./namespaceAllocation.ts";
import {
  canonicalRepository,
  ProvisionRuntimeArtifact,
  type EnvironmentControlConfig,
} from "./config.ts";
import { repositoryUrl } from "./driver.ts";
import { credentialDestinations } from "./credentialDestinations.ts";
import { stripCodexRefreshToken } from "../provider/codexLoginCopy.ts";
import {
  credentialVariables,
  guestCredentialDestination,
  isForeignCredentialVariable,
  ProvisionRefused,
  type ProvisioningProviderProfile,
  type ProvisioningProviderProfiles,
} from "./ProvisioningProviderProfile.ts";
import { guestProviderInstallCommand } from "./guestProviderInstall.ts";

export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const GitRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const File = Schema.Struct({
  scope: Schema.Literals(["home", "workspace"]),
  destination: Schema.String,
  sha256: Sha256,
  contentsBase64: Schema.String,
});
const Preparation = Schema.Struct({
  requestId: EnvironmentProvisionInput.fields.requestId,
  root: Schema.String,
  repository: Schema.NullOr(
    Schema.Struct({
      url: Schema.String,
      revision: GitRevision,
      accessToken: Schema.optional(Schema.String),
    }),
  ),
  artifact: Schema.Struct({
    archivePath: Schema.String,
    sha256: Sha256,
    revision: GitRevision,
    entrypoint: Schema.String,
    install: Schema.optional(Schema.Literal("npm")),
  }),
  runtimeExecutable: Schema.String,
  port: Schema.Int,
  readinessTimeoutSeconds: Schema.Int,
  brokerTtl: Schema.String,
  prepareCommands: Schema.optional(Schema.Array(Schema.String)),
  providerInstall: Schema.optional(Schema.String),
  artifacts: Schema.optional(
    Schema.Array(
      Schema.Struct({ path: Schema.String, destination: Schema.String, sha256: Sha256 }),
    ),
  ),
  files: Schema.Array(File),
});
export const ProvisionPreparationManifest = Schema.Struct({
  input: EnvironmentProvisionInput,
  request: DurableProvisionRequest,
  preparation: Preparation,
  localArtifact: ProvisionRuntimeArtifact,
  egressAllow: Schema.Array(Schema.String),
  /**
   * The repository's warm base key at freeze time (`warmBaseKey`, or `spareKey`
   * on Namespace), for a request whose repository keeps one. Outside
   * `preparation`, so it is not part of the preparation's identity.
   */
  warmKey: Schema.optional(Sha256),
});
export type ProvisionPreparationManifest = typeof ProvisionPreparationManifest.Type;
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProvisionPreparationManifest),
);
const decodeRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(ProvisionRuntimeArtifact));
/**
 * The build a guest converges to: the runtime record when one was set, else
 * the identity artifact the manifest pins. `local` is what the manager stages,
 * `guest` is the same build as the guest script wants it, on the guest volume
 * under the manifest's naming scheme.
 */
export function desiredRuntime(
  manifest: ProvisionPreparationManifest,
  runtime: ProvisionRuntimeArtifact | null,
): {
  local: ProvisionRuntimeArtifact;
  guest: ProvisionPreparationManifest["preparation"]["artifact"];
} {
  const identity = manifest.preparation.artifact;
  if (!runtime) return { local: manifest.localArtifact, guest: identity };
  return {
    local: runtime,
    guest: {
      archivePath: `${NodePath.posix.dirname(identity.archivePath)}/t3-runtime-${runtime.sha256}.tar`,
      sha256: runtime.sha256,
      revision: runtime.revision,
      entrypoint: runtime.entrypoint,
      ...(runtime.install ? { install: runtime.install } : {}),
    },
  };
}
/**
 * The branch a box's checkout follows each time it opens: the requested one, or
 * `HEAD` for the default. A request that pinned an exact revision follows none.
 */
export function followedBranch(manifest: ProvisionPreparationManifest): string | undefined {
  const { repository, branch, sourceRevision } = manifest.input;
  return repository && !sourceRevision ? (branch ?? "HEAD") : undefined;
}
/** The build this manager currently pins for a provider's guests, or null when none is configured. */
export function configuredRuntimeArtifact(
  config: EnvironmentControlConfig,
  provider: "e2b" | "namespace",
): ProvisionRuntimeArtifact | null {
  return config.provisioning?.runtimeArtifacts?.[provider === "e2b" ? "linux" : "macos"] ?? null;
}
/**
 * The cloud environments this configuration can provision. Each needs its
 * pinned runtime; E2B also needs its template and a Mac its Namespace
 * defaults. Namespace
 * credentials are checked when a provision starts, since `nsc login` can
 * supply them outside this file.
 */
export function provisionProviders(
  config: EnvironmentControlConfig,
): ReadonlyArray<ProvisionProvider> {
  return ProvisionProvider.literals.filter(
    (provider) =>
      configuredRuntimeArtifact(config, provider) !== null &&
      (provider === "e2b"
        ? Boolean(config.provisioning?.templateId)
        : config.provisioning?.namespace !== undefined),
  );
}
const decodeSettingsRecord = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    providers: Schema.Record(Schema.String, Schema.Unknown),
    providerInstances: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeInput = Schema.decodeUnknownSync(EnvironmentProvisionInput);
/**
 * Where a guest keeps everything T3 prepares: the checkout, the isolated home
 * with credentials and T3 state, the runtime archive.
 *
 * A Namespace Mac wipes /tmp and the runner home on shutdown but keeps its
 * Devbox volume, so only a root on that volume lets a paused Mac resume as the
 * same environment.
 *
 * Every E2B box prepares at one fixed root. A warm snapshot's checkout carries
 * absolute paths (Python venvs, prepare records, `$HOME` caches), so a base is
 * only reusable by a box that prepares where it was built. Each E2B request
 * has its own sandbox, so the request id never needed to be in the path.
 * Existing manifests keep the root they persisted.
 */
const guestVolume = { e2b: "/tmp", namespace: "/Volumes/devbox" } as const;
const E2B_ROOT = "/tmp/t3-provision/box";
export const provisionDigest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
/**
 * Hashes a file a chunk at a time. A runtime archive is about 150 MB, and
 * reading it whole held that much per concurrent provision and hashed it in
 * one synchronous call.
 */
export async function fileDigest(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
const provisionInputLimit = 64 * 1024 * 1024;

/**
 * Where an agent CLI reads skills inside a provisioned environment, relative
 * to its home directory.
 *
 * Every supported CLI resolves a user-scoped root, so skills land in the home
 * rather than the checkout. A checkout is what the agent opens a pull request
 * from, and a skill bundle committed by accident is worse than a missing one.
 */
function skillRoot(kind: ProvisioningProviderProfile["kind"]): string {
  if (kind === "cursor") return ".cursor/skills";
  if (kind === "claudeAgent") return ".claude/skills";
  return ".codex/skills";
}

type ChildSettings = {
  providers?: Record<string, Record<string, unknown>>;
  providerInstances?: Record<string, ChildProviderInstanceSettings>;
  [key: string]: unknown;
};
type ChildProviderInstanceSettings = Record<string, unknown> & {
  config?: Record<string, unknown>;
  environment?: Array<{ name: string; value: string; sensitive?: boolean }>;
};

/**
 * The instance id a provisioned environment keys a driver's account by.
 *
 * An enabled driver already contributes an implicit instance under this id, so
 * an account keyed by the manager's own slug leaves that implicit instance
 * enabled with no credentials for a guest client to pick. A guest holds one
 * account per driver and the manager's slug is not a routing key there, so the
 * account takes the id the guest would have synthesized anyway.
 */
const guestInstanceId = (agentDriver: string) =>
  defaultInstanceIdForDriver(ProviderDriverKind.make(agentDriver));

function enableChildProvider(
  existing: string,
  profiles: ProvisioningProviderProfiles,
  homePath = "/home/user",
  devices = false,
): string {
  let settings: ChildSettings = {};
  try {
    const parsed = JSON.parse(existing);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as ChildSettings;
    }
  } catch {}
  const providers = settings.providers ?? {};
  const providerInstances = settings.providerInstances ?? {};
  const accounts = profiles.map(({ kind: agentDriver, displayName, accountEmail }) => {
    const instanceId = guestInstanceId(agentDriver);
    const existingInstance = providerInstances[instanceId] ?? {};
    const environment =
      agentDriver === "cursor"
        ? [
            ...(existingInstance.environment ?? []).filter(
              (variable) =>
                !["AGENT_CLI_CREDENTIAL_STORE", "CURSOR_CONFIG_DIR", "HOME"].includes(
                  variable.name,
                ),
            ),
            { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
            { name: "CURSOR_CONFIG_DIR", value: `${homePath}/.config/cursor`, sensitive: false },
            { name: "HOME", value: homePath, sensitive: false },
          ]
        : existingInstance.environment;
    return [
      instanceId,
      {
        ...existingInstance,
        driver: agentDriver,
        enabled: true,
        // Carried from the manager rather than left for the guest to discover:
        // a Claude guest authenticates with a bare OAuth token, which carries
        // no account profile, so no on-box probe could ever recover this name.
        ...(displayName ? { displayName } : {}),
        // Driver settings live under `config`; the contract drops them anywhere else.
        ...(agentDriver === "codex"
          ? {
              config: {
                ...existingInstance.config,
                homePath: `${homePath}/.codex`,
                shadowHomePath: "",
              },
            }
          : {}),
        // The guest's setup token cannot name its account either, and Limits
        // keys one account across machines by email.
        ...(accountEmail ? { config: { ...existingInstance.config, accountEmail } } : {}),
        ...(environment ? { environment } : {}),
      },
    ] as const;
  });
  const enabled = new Set<string>(profiles.map(({ kind }) => kind));
  return `${JSON.stringify({
    ...settings,
    // Namespace children are macOS Macs used for iOS work; nobody opens
    // settings on a cloud Mac to flip device access on by hand.
    ...(devices ? { enableDeviceSupport: true, enableAgentDeviceAccess: true } : {}),
    providers: {
      ...providers,
      // Only the provisioned drivers' CLIs are installed here, so every other
      // driver offers an account no turn can run on.
      ...Object.fromEntries(
        [...new Set([...Object.keys(DEFAULT_SERVER_SETTINGS.providers), ...enabled])].map(
          (driver) => [driver, { ...providers[driver], enabled: enabled.has(driver) }],
        ),
      ),
    },
    providerInstances: { ...providerInstances, ...Object.fromEntries(accounts) },
  })}\n`;
}

function relativePath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    NodePath.posix.isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new ProvisionRefused({
      reason: "unconfigured",
      message: "Provisioned files require a relative path within their destination.",
    });
  return path;
}
function file(scope: "home" | "workspace", destination: string, data: Uint8Array) {
  return {
    scope,
    destination: relativePath(destination),
    sha256: provisionDigest(data),
    contentsBase64: Buffer.from(data).toString("base64"),
  };
}
/**
 * Reads a file a home receives. Every Codex login goes out unable to refresh
 * (`stripCodexRefreshToken`). Codex rewrites `auth.json` in place, so a read
 * that catches it mid-write is retried, and a login that still cannot be
 * parsed is refused rather than handed on raw.
 */
async function homeFileData(destination: string, read: () => Promise<Buffer>) {
  if (!credentialDestinations.codex.includes(relativePath(destination))) return await read();
  for (let attempt = 0; attempt < CODEX_LOGIN_READ_ATTEMPTS; attempt++) {
    if (attempt > 0) await NodeTimersPromises.setTimeout(CODEX_LOGIN_READ_RETRY_MS);
    const stripped = stripCodexRefreshToken((await read()).toString("utf8"));
    if (stripped !== undefined) return Buffer.from(stripped);
  }
  throw new ProvisionRefused({
    reason: "credentials",
    message: "A Codex login on this manager could not be read, so it was not copied. Try again.",
  });
}
const CODEX_LOGIN_READ_ATTEMPTS = 3;
const CODEX_LOGIN_READ_RETRY_MS = 100;
function submittedFiles(input: EnvironmentProvisionInput) {
  let size = 0;
  return (input.workspaceFiles ?? []).map((item) => {
    if (item.contentsBase64.length > Math.ceil(provisionInputLimit / 3) * 4)
      throw new ProvisionRefused({
        reason: "unsupported",
        message: "Provisioning input exceeds the 64 MiB file limit.",
      });
    const data = Buffer.from(item.contentsBase64, "base64");
    size += data.length;
    if (size > provisionInputLimit)
      throw new ProvisionRefused({
        reason: "unsupported",
        message: "Provisioning input exceeds the 64 MiB file limit.",
      });
    if (data.toString("base64") !== item.contentsBase64 || provisionDigest(data) !== item.sha256)
      throw new ProvisionRefused({
        reason: "unsupported",
        message: "A submitted provisioning file failed its content hash check.",
      });
    return file("workspace", item.destination, data);
  });
}

/**
 * Every file in a skill bundle, by path within it.
 *
 * A bundle is configuration a manager operator points at, but it lands in an
 * environment that then holds whatever it names, so a link out of the bundle
 * is refused rather than resolved. A link that stays inside it is carried as
 * an ordinary file, which is the shape npm leaves behind in a skill that has
 * its own scripts.
 */
async function skillFiles(source: string, limit: { remaining: number }) {
  const collected: Array<{ path: string; data: Uint8Array }> = [];
  const root = await NodeFSP.realpath(source);
  const inside = (resolved: string) =>
    resolved === root || resolved.startsWith(`${root}${NodePath.sep}`);
  const add = async (absolute: string, relative: string) => {
    const data = await NodeFSP.readFile(absolute);
    limit.remaining -= data.length;
    if (limit.remaining < 0)
      throw new ProvisionRefused({
        reason: "unsupported",
        message: "Configured skill bundles exceed the 64 MiB file limit.",
      });
    collected.push({ path: relative, data });
  };
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        const resolved = await NodeFSP.realpath(absolute).catch(() => undefined);
        // A dangling link names nothing that could land in the environment.
        if (resolved === undefined) continue;
        if (!inside(resolved))
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: `A configured skill bundle links outside itself at ${relative}.`,
          });
        // A link to a directory inside the bundle only repeats files this walk
        // already reaches, and can cycle.
        if ((await NodeFSP.stat(resolved)).isFile()) await add(resolved, relative);
        continue;
      }
      if (entry.isDirectory()) {
        // A skill is its prompts and scripts. Installed dependencies and Git
        // history are host-shaped and enormous next to that: one checked-in
        // node_modules turned a 850 KiB bundle into a 37 MiB one that every
        // cold start re-encoded, shipped, and wrote out file by file.
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;
      await add(absolute, relative);
    }
  };
  await walk(root, "");
  return collected;
}

async function privateDirectory(path: string) {
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Provisioning state directory must be private.");
}
async function privateRead(path: string) {
  const stat = await NodeFSP.lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Provisioning state file must be private.");
  return await NodeFSP.readFile(path, "utf8");
}
/** `fill` creates the temporary file; the first complete, fsynced one wins `path`. */
export async function writeOnce(path: string, fill: (temporary: string) => Promise<void>) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await fill(temporary);
    const handle = await NodeFSP.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.link(temporary, path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const directory = await NodeFSP.open(NodePath.dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** Atomic replace for a mutable private record. */
export async function writeReplace(path: string, data: string) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, path);
  const directory = await NodeFSP.open(NodePath.dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export interface ProvisionPreparationResolver {
  readonly template: (configured: string) => Promise<string>;
  readonly revision: (repository: string, branch?: string) => Promise<string>;
}

/** Digests of the files every checkout receives, which a prepared tree may have consumed. */
async function workspaceFileDigests(
  provisioning: NonNullable<EnvironmentControlConfig["provisioning"]>,
) {
  const digests = [];
  for (const configured of provisioning.workspaceFiles ?? [])
    digests.push({
      destination: configured.destination,
      sha256: provisionDigest(await NodeFSP.readFile(configured.source)),
    });
  return digests;
}

/**
 * What a repository's warm E2B snapshot has on disk, or null when the
 * repository keeps no warm base. Chat freezes and the warm base upkeep both
 * key on this, so they cannot disagree about whether a base fits.
 *
 * Home files are left out: credentials rotate, and sealing a base removes
 * them. So are the revision and branch, which each chat fetches into the warm
 * checkout, and the provider CLI install, which each chat reruns.
 */
export async function warmBaseKey(
  config: EnvironmentControlConfig,
  repository: string,
  resolver: Pick<ProvisionPreparationResolver, "template">,
): Promise<string | null> {
  const provisioning = config.provisioning;
  const runtime = configuredRuntimeArtifact(config, "e2b");
  if (!provisioning?.templateId || !runtime || provisioning.warmBaseRefreshHours === 0) return null;
  const setup = provisioning.repositories?.find(
    (entry) => canonicalRepository(entry.repository) === canonicalRepository(repository),
  )?.e2b;
  const prepareCommands = setup?.prepareCommands ?? [];
  if (setup?.warm !== true || prepareCommands.length === 0) return null;
  return provisionDigest(
    stableStringify({
      version: 1,
      repository: repositoryUrl(repository),
      templateId: await resolver.template(provisioning.templateId),
      runtime: runtime.sha256,
      root: E2B_ROOT,
      prepareCommands,
      egressAllow: provisioning.egressAllow ?? [],
      workspaceFiles: await workspaceFileDigests(provisioning),
    }),
  );
}

/** What a Namespace request asks the provider for, which a spare's Devbox must already be. */
async function namespaceMachine(config: EnvironmentControlConfig) {
  const namespace = config.provisioning?.namespace;
  if (!namespace)
    throw new ProvisionRefused({
      reason: "unconfigured",
      message: "Configure Namespace before provisioning.",
    });
  return {
    ...(await resolveNamespaceIdentity(config.namespaceToken)),
    size: namespace.size,
    region: namespace.region ?? "iad",
    image: namespaceMacImage,
    idleTimeoutMinutes: namespace.idleTimeoutMinutes ?? 360,
  };
}

/**
 * What a repository's Namespace spare is and has on disk, or null when the
 * repository keeps no spare. The counterpart of `warmBaseKey`, leaving out the
 * same things. It adds the machine, because a chat adopts the spare's Devbox
 * as created, and the artifacts its prepare commands consume.
 */
export async function spareKey(
  config: EnvironmentControlConfig,
  repository: string,
): Promise<string | null> {
  const provisioning = config.provisioning;
  const runtime = configuredRuntimeArtifact(config, "namespace");
  if (!provisioning?.namespace || !runtime || provisioning.warmBaseRefreshHours === 0) return null;
  const setup = provisioning.repositories?.find(
    (entry) => canonicalRepository(entry.repository) === canonicalRepository(repository),
  )?.namespace;
  const prepareCommands = setup?.prepareCommands ?? provisioning.namespace.prepareCommands ?? [];
  if (setup?.spare !== true || prepareCommands.length === 0) return null;
  return provisionDigest(
    stableStringify({
      version: 1,
      repository: repositoryUrl(repository),
      machine: await namespaceMachine(config),
      runtime: runtime.sha256,
      prepareCommands,
      artifacts: setup.artifacts ?? provisioning.namespace.artifacts ?? [],
      workspaceFiles: await workspaceFileDigests(provisioning),
    }),
  );
}

/** The first complete, fsynced manifest wins across manager processes. Retries never reread mutable config. */
export function makeProvisionPreparationStore(stateDir: string) {
  const directory = NodePath.join(stateDir, "provisioning");
  const manifestPath = (id: ProvisionRequestId) => NodePath.join(directory, `${id}.json`);
  const runtimePath = (id: ProvisionRequestId) => NodePath.join(directory, `${id}.runtime.json`);
  /** Copies a configured artifact into the store so a later config edit cannot change what a guest receives. */
  const storeArtifact = async (artifact: ProvisionRuntimeArtifact) => {
    relativePath(artifact.entrypoint);
    const artifactPath = NodePath.join(directory, `${artifact.sha256}.tar`);
    const stored = await fileDigest(artifactPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stored === null)
      await writeOnce(artifactPath, async (temporary) => {
        await NodeFSP.copyFile(artifact.path, temporary, NodeFSP.constants.COPYFILE_EXCL);
        await NodeFSP.chmod(temporary, 0o600);
        if ((await fileDigest(temporary)) !== artifact.sha256)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "The configured runtime artifact failed its content hash check.",
          });
      });
    else if (stored !== artifact.sha256) throw new Error("Stored runtime artifact changed.");
    return { ...artifact, path: artifactPath };
  };
  const load = async (id: ProvisionRequestId): Promise<ProvisionPreparationManifest> => {
    const manifest = decodeManifest(await privateRead(manifestPath(id)));
    if (
      manifest.request.preparationHash !==
      provisionDigest(
        stableStringify({ preparation: manifest.preparation, egressAllow: manifest.egressAllow }),
      )
    )
      throw new Error("Stored preparation manifest changed.");
    return manifest;
  };
  return {
    load,
    readRuntime: async (id: ProvisionRequestId): Promise<ProvisionRuntimeArtifact | null> => {
      const raw = await privateRead(runtimePath(id)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return raw === null ? null : decodeRuntime(raw);
    },
    setRuntime: async (
      id: ProvisionRequestId,
      artifact: ProvisionRuntimeArtifact,
    ): Promise<ProvisionRuntimeArtifact> => {
      await load(id);
      const stored = await storeArtifact(artifact);
      await writeReplace(runtimePath(id), stableStringify(stored));
      return stored;
    },
    freeze: async (
      rawInput: EnvironmentProvisionInput,
      config: EnvironmentControlConfig,
      resolver: ProvisionPreparationResolver,
      /**
       * The accounts a new request runs. A function is called only when the request is new: a
       * retry of an accepted request keeps the accounts it froze, whatever routing says now.
       */
      profilesFor: ProvisioningProviderProfiles | (() => Promise<ProvisioningProviderProfiles>),
      /**
       * The warm snapshot a new E2B chat starts from, by canonical repository and
       * warm key, or null to start cold. A warm base's own build passes none.
       */
      warmTemplate?: (repository: string, key: string) => Promise<string | null>,
      /**
       * The spare a new Namespace chat may claim, by canonical repository and
       * spare key, and the claim itself, which only one chat wins. A spare's
       * own build passes none.
       */
      spares?: {
        readonly select: (repository: string, key: string) => Promise<ProvisionRequestId | null>;
        readonly claim: (spare: ProvisionRequestId, chat: ProvisionRequestId) => Promise<boolean>;
      },
    ): Promise<ProvisionPreparationManifest> => {
      const input = decodeInput(rawInput);
      const submitted = submittedFiles(input);
      await privateDirectory(directory);
      const existing = await load(input.requestId).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing) {
        if (stableStringify(existing.input) !== stableStringify(input))
          throw new ProvisionRequestConflict({ requestId: input.requestId });
        return existing;
      }
      const profiles = typeof profilesFor === "function" ? await profilesFor() : profilesFor;
      const provisioning = config.provisioning;
      const artifact = configuredRuntimeArtifact(config, input.provider);
      if (!provisioning || !artifact)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message:
            "Configure a pinned runtime artifact for this cloud platform before provisioning.",
        });
      if (input.sourceRevision && !input.repository)
        throw new ProvisionRefused({
          reason: "unsupported",
          message: "An exact source revision requires a repository.",
        });
      const repository = input.repository
        ? {
            url: repositoryUrl(input.repository),
            revision:
              input.sourceRevision ?? (await resolver.revision(input.repository, input.branch)),
            ...(provisioning.githubToken ? { accessToken: provisioning.githubToken } : {}),
          }
        : null;
      const volume = guestVolume[input.provider];
      let warmKey: string | null = null;
      // A chat that claims a spare becomes the owner of its Devbox and prepares
      // where the spare was built: its tree carries absolute paths, like a warm
      // E2B base's. Claimed before anything is derived from the root. A freeze
      // that fails after this leaves the claim to the upkeep, which disposes a
      // spare whose chat never froze.
      let spare: ProvisionRequestId | null = null;
      if (input.provider === "namespace" && input.repository) {
        warmKey = await spareKey(config, input.repository);
        const candidate =
          warmKey && spares
            ? await spares.select(canonicalRepository(input.repository), warmKey)
            : null;
        if (candidate && spares && (await spares.claim(candidate, input.requestId)))
          spare = candidate;
      }
      const root =
        input.provider === "e2b" ? E2B_ROOT : `${volume}/t3-provision/${spare ?? input.requestId}`;
      const localArtifact = await storeArtifact(artifact);
      let files: Array<typeof File.Type> = [...submitted];
      for (const scope of ["home", "workspace"] as const) {
        for (const configured of provisioning[scope === "home" ? "homeFiles" : "workspaceFiles"] ??
          []) {
          const read = () => NodeFSP.readFile(configured.source);
          files.push(
            file(
              scope,
              configured.destination,
              scope === "home" ? await homeFileData(configured.destination, read) : await read(),
            ),
          );
        }
      }
      const skillLimit = { remaining: provisionInputLimit };
      for (const skill of provisioning.skills ?? []) {
        const skillRoots = new Set(
          profiles
            .filter(({ kind }) => !skill.agents || skill.agents.includes(kind))
            .map(({ kind }) => skillRoot(kind)),
        );
        if (skillRoots.size === 0) continue;
        const prefix = skill.name ? `${relativePath(skill.name)}/` : "";
        for (const entry of await skillFiles(skill.source, skillLimit)) {
          for (const root of skillRoots)
            files.push(file("home", `${root}/${prefix}${entry.path}`, entry.data));
        }
      }
      // A configured home file never decides which login a provisioned account
      // uses. A CLI handed a stale credentials file prefers it over the token
      // and fails the turn refreshing a login this manager no longer keeps,
      // so the credential provisioning resolved replaces every copy of it --
      // including the ones a file credential does not itself write, which a
      // guest on another platform would read first.
      const replaced = new Set(profiles.flatMap(({ kind }) => credentialDestinations[kind]));
      files = files.filter((item) => !(item.scope === "home" && replaced.has(item.destination)));
      for (const profile of profiles) {
        if (profile.credential.kind !== "file") continue;
        const { source } = profile.credential;
        const destination = guestCredentialDestination(
          profile.kind,
          profile.credential.destination,
          input.provider,
        );
        const credential = await homeFileData(destination, () =>
          NodeFSP.readFile(source).catch(() => {
            throw new ProvisionRefused({
              reason: "credentials",
              message: "The selected provider account has no credentials on this manager.",
            });
          }),
        );
        files.push(file("home", destination, credential));
      }
      const settingsPath = ".t3/userdata/settings.json";
      const settingsIndex = files.findIndex(
        (item) => item.scope === "home" && item.destination === settingsPath,
      );
      const settings =
        settingsIndex === -1
          ? "{}"
          : Buffer.from(files[settingsIndex]!.contentsBase64, "base64").toString();
      if (settingsIndex !== -1) files.splice(settingsIndex, 1);
      // Environment entries reach the provider's child process without shell interpolation.
      const configuredSettings: unknown = JSON.parse(
        enableChildProvider(settings, profiles, `${root}/home`, input.provider === "namespace"),
      );
      const parsedSettings = decodeSettings(configuredSettings);
      const kinds = profiles.map(({ kind }) => kind);
      const environment: Array<{ name: string; value: string; sensitive: boolean }> = [];
      for (const variable of provisioning.shellEnvironment ?? []) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) ||
          ["HOME", "T3CODE_HOME"].includes(variable.name)
        )
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "A configured environment variable would change the isolated home.",
          });
        if (isForeignCredentialVariable(kinds, variable.name)) continue;
        environment.push({
          name: variable.name,
          value: (await NodeFSP.readFile(variable.source, "utf8")).trim(),
          sensitive: true,
        });
      }
      const accounts = profiles.map((profile) => {
        const credentials =
          profile.credential.kind === "environment"
            ? profile.environment.filter(
                ({ name, value }) =>
                  credentialVariables[profile.kind].includes(name) && value.trim(),
              )
            : [];
        const instanceId = guestInstanceId(profile.kind);
        return [
          instanceId,
          {
            ...parsedSettings.providerInstances[instanceId],
            environment: [
              ...environment.filter(
                ({ name }) =>
                  !isForeignCredentialVariable([profile.kind], name) &&
                  !credentials.some((c) => c.name === name),
              ),
              ...credentials,
              ...(profile.kind === "cursor"
                ? [{ name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false }]
                : []),
            ],
          },
        ] as const;
      });
      const resultSettings = {
        ...decodeSettingsRecord(configuredSettings),
        ...parsedSettings,
        providerInstances: {
          ...parsedSettings.providerInstances,
          ...Object.fromEntries(accounts),
        },
      };
      files.push(file("home", settingsPath, Buffer.from(JSON.stringify(resultSettings))));
      if (provisioning.githubToken) {
        files.push(
          file(
            "home",
            ".config/gh/hosts.yml",
            Buffer.from(
              `github.com:\n    oauth_token: ${provisioning.githubToken}\n    git_protocol: https\n`,
            ),
          ),
        );
        files.push(
          file(
            "home",
            ".git-credentials",
            Buffer.from(
              `https://x-access-token:${encodeURIComponent(provisioning.githubToken)}@github.com\n`,
            ),
          ),
        );
        files.push(
          file(
            "home",
            ".gitconfig",
            Buffer.from(
              "[credential]\n\thelper = store\n[user]\n\tname = T3\n\temail = agent@t3.local\n" +
                '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = ssh://git@github.com/\n',
            ),
          ),
        );
      }
      const destinations = new Set<string>();
      for (const item of files) {
        const destination = `${item.scope}:${item.destination}`;
        if (destinations.has(destination))
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "Provisioning files contain duplicate destinations.",
          });
        destinations.add(destination);
      }
      // A prepared environment has two halves, and only one of them is about
      // this request.
      //
      // `build` is what the disk would contain for anyone asking the same
      // thing: the repository at a revision, the runtime artifact, and how it
      // is started. Identical inputs describe an identical machine, so it is
      // the identity a prepared parent, a snapshot, or a baked base image can
      // all be keyed on — the same idea whichever provider realises it.
      //
      // The overlay below is what only this request wants: its id, the root
      // named after it, and the files it carries. Those are why every request
      // currently hashes differently even when the machine is the same, and
      // why nothing prepared can be shared yet.
      // What an operator configured for this repository on this platform, the
      // same precedence the direct preparation path applies: a repository
      // entry replaces the platform default rather than adding to it.
      const repositoryEntry = input.repository
        ? provisioning.repositories?.find(
            (entry) =>
              canonicalRepository(entry.repository) === canonicalRepository(input.repository!),
          )
        : undefined;
      const repositorySetup = repositoryEntry?.[input.provider];
      const prepareCommands =
        repositorySetup?.prepareCommands ??
        (input.provider === "namespace" ? provisioning.namespace?.prepareCommands : undefined) ??
        [];
      // Identity only. The download URL Namespace signs for an artifact
      // expires long before this manifest stops being replayed, so each
      // convergence resolves one afresh.
      const artifacts =
        input.provider === "namespace"
          ? (repositoryEntry?.namespace?.artifacts ?? provisioning.namespace?.artifacts ?? [])
          : [];
      const providerInstall = profiles
        .flatMap(({ kind }) => guestProviderInstallCommand(kind) ?? [])
        .join(" && ");
      const build = {
        repository,
        artifact: {
          archivePath: `${volume}/t3-runtime-${artifact.sha256}.tar`,
          sha256: artifact.sha256,
          revision: artifact.revision,
          entrypoint: artifact.entrypoint,
          ...(artifact.install ? { install: artifact.install } : {}),
        },
        runtimeExecutable: artifact.runtimeExecutable,
        port: 3773,
        readinessTimeoutSeconds: 180,
        brokerTtl: "7d",
        // Part of `build`: a checkout nobody prepared is a different machine
        // from one that was, so two requests only match when these match.
        ...(prepareCommands.length ? { prepareCommands } : {}),
        ...(artifacts.length ? { artifacts } : {}),
        // Frozen with the accounts it installs CLIs for. A manifest from before
        // this field has none, and its runtime keeps deriving the one command
        // from the request's driver so its preparation identity never moves.
        ...(providerInstall ? { providerInstall } : {}),
      };
      const preparation = {
        ...build,
        requestId: input.requestId,
        root,
        files,
      };
      const common = {
        requestId: input.requestId,
        ...(input.retentionDeadline ? { retentionDeadline: input.retentionDeadline } : {}),
        // The account routing chose, which the input only hinted at. The
        // lease, the sandbox's metadata, and discovery all read it from here.
        providerInstanceId: profiles[0].instanceId,
        companionInstanceIds: profiles.slice(1).map(({ instanceId }) => instanceId),
        ...(input.agentDriver ? { agentDriver: input.agentDriver } : {}),
        ...(input.repository ? { repository: input.repository } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
        sourceRevision: repository?.revision ?? null,
        preparationHash: provisionDigest(
          stableStringify({ preparation, egressAllow: provisioning.egressAllow ?? [] }),
        ),
        // Reusing a prepared environment means recognising that two requests
        // describe the same machine. Recorded now so that identity exists and
        // is observable; nothing keys off it yet.
        buildHash: provisionDigest(
          stableStringify({ build, egressAllow: provisioning.egressAllow ?? [] }),
        ),
      };
      let request: DurableProvisionRequest;
      if (input.provider === "e2b") {
        const configuredTemplate = provisioning.templateId;
        if (!configuredTemplate)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "Configure an E2B template before provisioning.",
          });
        let resolved: Promise<string> | undefined;
        const template = () => (resolved ??= resolver.template(configuredTemplate));
        let warm: string | null = null;
        if (input.repository) {
          warmKey = await warmBaseKey(config, input.repository, { template });
          if (warmKey && warmTemplate)
            warm = await warmTemplate(canonicalRepository(input.repository), warmKey);
        }
        request = {
          ...common,
          provider: "e2b",
          ...(warm
            ? { templateId: warm, strategy: "direct" as const }
            : { templateId: await template(), strategy: "fork" as const }),
        };
      } else {
        request = {
          ...common,
          provider: "namespace",
          ...(await namespaceMachine(config)),
          ...(spare ? { devboxName: `t3-${spare}` } : {}),
        };
      }
      const manifest: ProvisionPreparationManifest = {
        input,
        request,
        preparation,
        localArtifact,
        egressAllow: provisioning.egressAllow ?? [],
        ...(warmKey ? { warmKey } : {}),
      };
      await writeOnce(manifestPath(input.requestId), (temporary) =>
        NodeFSP.writeFile(temporary, stableStringify(manifest), { flag: "wx", mode: 0o600 }),
      );
      const saved = await load(input.requestId);
      if (stableStringify(saved.input) !== stableStringify(input))
        throw new ProvisionRequestConflict({ requestId: input.requestId });
      return saved;
    },
  };
}
