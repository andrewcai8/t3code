// @effect-diagnostics nodeBuiltinImport:off - immutable private inputs are captured at the filesystem and provider boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  DEFAULT_SERVER_SETTINGS,
  DurableProvisionRequest,
  defaultInstanceIdForDriver,
  EnvironmentProvisionInput,
  ProviderDriverKind,
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
import {
  credentialDestinations,
  credentialVariables,
  guestCredentialDestination,
  isForeignCredentialVariable,
  ProvisionRefused,
  type ProvisioningProviderProfile,
} from "./ProvisioningProviderProfile.ts";

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const GitRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
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
});
export type ProvisionPreparationManifest = typeof ProvisionPreparationManifest.Type;
const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProvisionPreparationManifest),
);
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
 * same environment. E2B pauses memory and disk together, so its root stays
 * where every existing manifest already put it.
 */
const guestVolume = { e2b: "/tmp", namespace: "/Volumes/devbox" } as const;
export const provisionDigest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
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
 * The instance id a provisioned environment keys its one account by.
 *
 * An enabled driver already contributes an implicit instance under this id, so
 * an account keyed by the manager's own slug leaves that implicit instance
 * enabled with no credentials for a guest client to pick. A guest holds exactly
 * one account and the manager's slug is not a routing key there, so the account
 * takes the id the guest would have synthesized anyway.
 */
const guestInstanceId = (agentDriver: string) =>
  defaultInstanceIdForDriver(ProviderDriverKind.make(agentDriver));

function enableChildProvider(
  existing: string,
  agentDriver: string,
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
  const instanceId = guestInstanceId(agentDriver);
  const existingInstance = providerInstances[instanceId] ?? {};
  const environment =
    agentDriver === "cursor"
      ? [
          ...(existingInstance.environment ?? []).filter(
            (variable) =>
              !["AGENT_CLI_CREDENTIAL_STORE", "CURSOR_CONFIG_DIR", "HOME"].includes(variable.name),
          ),
          { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
          { name: "CURSOR_CONFIG_DIR", value: `${homePath}/.config/cursor`, sensitive: false },
          { name: "HOME", value: homePath, sensitive: false },
        ]
      : existingInstance.environment;
  return `${JSON.stringify({
    ...settings,
    // Namespace children are macOS Macs used for iOS work; nobody opens
    // settings on a cloud Mac to flip device access on by hand.
    ...(devices ? { enableDeviceSupport: true, enableAgentDeviceAccess: true } : {}),
    providers: {
      ...providers,
      // Only one agent CLI is installed here, so every other driver offers an
      // account no turn can run on.
      ...Object.fromEntries(
        Object.keys(DEFAULT_SERVER_SETTINGS.providers)
          .filter((driver) => driver !== agentDriver)
          .map((driver) => [driver, { ...providers[driver], enabled: false }]),
      ),
      [agentDriver]: { ...providers[agentDriver], enabled: true },
    },
    providerInstances: {
      ...providerInstances,
      [instanceId]: {
        ...existingInstance,
        driver: agentDriver,
        enabled: true,
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
        ...(environment ? { environment } : {}),
      },
    },
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
async function writeOnce(path: string, data: string | Uint8Array) {
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
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
    await NodeFSP.unlink(temporary);
  }
}

export interface ProvisionPreparationResolver {
  readonly template: (configured: string) => Promise<string>;
  readonly revision: (repository: string, branch?: string) => Promise<string>;
}

/** The first complete, fsynced manifest wins across manager processes. Retries never reread mutable config. */
export function makeProvisionPreparationStore(stateDir: string) {
  const directory = NodePath.join(stateDir, "provisioning");
  const manifestPath = (id: ProvisionRequestId) => NodePath.join(directory, `${id}.json`);
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
    freeze: async (
      rawInput: EnvironmentProvisionInput,
      config: EnvironmentControlConfig,
      resolver: ProvisionPreparationResolver,
      profile: ProvisioningProviderProfile,
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
      const provisioning = config.provisioning;
      const artifact =
        provisioning?.runtimeArtifacts?.[input.provider === "e2b" ? "linux" : "macos"];
      if (!provisioning || !artifact)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message:
            "Configure a pinned runtime artifact for this cloud platform before provisioning.",
        });
      relativePath(artifact.entrypoint);
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
      const root = `${volume}/t3-provision/${input.requestId}`;
      const artifactBytes = await NodeFSP.readFile(artifact.path);
      if (provisionDigest(artifactBytes) !== artifact.sha256)
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: "The configured runtime artifact failed its content hash check.",
        });
      const artifactPath = NodePath.join(directory, `${artifact.sha256}.tar`);
      await writeOnce(artifactPath, artifactBytes);
      if (provisionDigest(await NodeFSP.readFile(artifactPath)) !== artifact.sha256)
        throw new Error("Stored runtime artifact changed.");
      let files: Array<typeof File.Type> = [...submitted];
      for (const scope of ["home", "workspace"] as const) {
        for (const configured of provisioning[scope === "home" ? "homeFiles" : "workspaceFiles"] ??
          []) {
          files.push(
            file(scope, configured.destination, await NodeFSP.readFile(configured.source)),
          );
        }
      }
      const skillLimit = { remaining: provisionInputLimit };
      for (const skill of provisioning.skills ?? []) {
        const prefix = skill.name ? `${relativePath(skill.name)}/` : "";
        for (const entry of await skillFiles(skill.source, skillLimit)) {
          files.push(file("home", `${skillRoot(profile.kind)}/${prefix}${entry.path}`, entry.data));
        }
      }
      // A configured home file never decides which login the selected account
      // uses. A CLI handed a stale credentials file prefers it over the token
      // and fails the turn refreshing a login this manager no longer keeps,
      // so the credential provisioning resolved replaces every copy of it --
      // including the ones a file credential does not itself write, which a
      // guest on another platform would read first.
      const replaced = new Set(credentialDestinations[profile.kind]);
      files = files.filter((item) => !(item.scope === "home" && replaced.has(item.destination)));
      if (profile.credential.kind === "file") {
        const { source } = profile.credential;
        const destination = guestCredentialDestination(
          profile.kind,
          profile.credential.destination,
          input.provider,
        );
        const credential = await NodeFSP.readFile(source).catch(() => {
          throw new ProvisionRefused({
            reason: "credentials",
            message: "The selected provider account has no credentials on this manager.",
          });
        });
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
        enableChildProvider(settings, profile.kind, `${root}/home`, input.provider === "namespace"),
      );
      const parsedSettings = decodeSettings(configuredSettings);
      const environment = [];
      for (const variable of provisioning.shellEnvironment ?? []) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) ||
          ["HOME", "T3CODE_HOME"].includes(variable.name)
        )
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "A configured environment variable would change the isolated home.",
          });
        if (isForeignCredentialVariable(profile.kind, variable.name)) continue;
        environment.push({
          name: variable.name,
          value: (await NodeFSP.readFile(variable.source, "utf8")).trim(),
          sensitive: true,
        });
      }
      const credentials =
        profile.credential.kind === "environment"
          ? profile.environment.filter(
              ({ name, value }) => credentialVariables[profile.kind].includes(name) && value.trim(),
            )
          : [];
      const instanceId = guestInstanceId(profile.kind);
      const selected = parsedSettings.providerInstances[instanceId] ?? {};
      const resultSettings = {
        ...decodeSettingsRecord(configuredSettings),
        ...parsedSettings,
        providerInstances: {
          ...parsedSettings.providerInstances,
          [instanceId]: {
            ...selected,
            environment: [
              ...environment.filter(({ name }) => !credentials.some((c) => c.name === name)),
              ...credentials,
              ...(profile.kind === "cursor"
                ? [{ name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false }]
                : []),
            ],
          },
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
              "[credential]\n\thelper = store\n[user]\n\tname = T3\n\temail = agent@t3.local\n",
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
        providerInstanceId: input.providerInstanceId,
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
        if (!provisioning.templateId)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "Configure an E2B template before provisioning.",
          });
        request = {
          ...common,
          provider: "e2b",
          templateId: await resolver.template(provisioning.templateId),
          strategy: "fork",
        };
      } else {
        if (!provisioning.namespace)
          throw new ProvisionRefused({
            reason: "unconfigured",
            message: "Configure Namespace before provisioning.",
          });
        request = {
          ...common,
          provider: "namespace",
          ...(await resolveNamespaceIdentity(config.namespaceToken)),
          size: provisioning.namespace.size,
          region: provisioning.namespace.region ?? "iad",
          image: namespaceMacImage,
          idleTimeoutMinutes: provisioning.namespace.idleTimeoutMinutes ?? 360,
        };
      }
      const manifest: ProvisionPreparationManifest = {
        input,
        request,
        preparation,
        localArtifact: { ...artifact, path: artifactPath },
        egressAllow: provisioning.egressAllow ?? [],
      };
      await writeOnce(manifestPath(input.requestId), stableStringify(manifest));
      const saved = await load(input.requestId);
      if (stableStringify(saved.input) !== stableStringify(input))
        throw new ProvisionRequestConflict({ requestId: input.requestId });
      return saved;
    },
  };
}
