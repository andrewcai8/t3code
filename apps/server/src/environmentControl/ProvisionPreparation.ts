// @effect-diagnostics nodeBuiltinImport:off - immutable private inputs are captured at the filesystem and provider boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  DurableProvisionRequest,
  EnvironmentProvisionInput,
  ProvisionRequestConflict,
  type ProvisionRequestId,
} from "@t3tools/contracts";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { resolveNamespaceIdentity, namespaceMacImage } from "./namespaceAllocation.ts";
import { ProvisionRuntimeArtifact, type EnvironmentControlConfig } from "./config.ts";
import { accountAuthPath, enableChildProvider, ProvisionRefused, repositoryUrl } from "./driver.ts";

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
export const provisionDigest = (value: string | Uint8Array) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export const provisionInputLimit = 64 * 1024 * 1024;

function relativePath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    NodePath.posix.isAbsolute(path) ||
    path.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new ProvisionRefused(
      "unconfigured",
      "Provisioned files require a relative path within their destination.",
    );
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
      throw new ProvisionRefused(
        "unsupported",
        "Provisioning input exceeds the 64 MiB file limit.",
      );
    const data = Buffer.from(item.contentsBase64, "base64");
    size += data.length;
    if (size > provisionInputLimit)
      throw new ProvisionRefused(
        "unsupported",
        "Provisioning input exceeds the 64 MiB file limit.",
      );
    if (data.toString("base64") !== item.contentsBase64 || provisionDigest(data) !== item.sha256)
      throw new ProvisionRefused(
        "unsupported",
        "A submitted provisioning file failed its content hash check.",
      );
    return file("workspace", item.destination, data);
  });
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
      home = NodeOS.homedir(),
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
        throw new ProvisionRefused(
          "unconfigured",
          "Configure a pinned runtime artifact for this cloud platform before provisioning.",
        );
      relativePath(artifact.entrypoint);
      if (input.sourceRevision && !input.repository)
        throw new ProvisionRefused(
          "unsupported",
          "An exact source revision requires a repository.",
        );
      const repository = input.repository
        ? {
            url: repositoryUrl(input.repository),
            revision:
              input.sourceRevision ?? (await resolver.revision(input.repository, input.branch)),
            ...(provisioning.githubToken ? { accessToken: provisioning.githubToken } : {}),
          }
        : null;
      const artifactBytes = await NodeFSP.readFile(artifact.path);
      if (provisionDigest(artifactBytes) !== artifact.sha256)
        throw new ProvisionRefused(
          "unconfigured",
          "The configured runtime artifact failed its content hash check.",
        );
      const artifactPath = NodePath.join(directory, `${artifact.sha256}.tar`);
      await writeOnce(artifactPath, artifactBytes);
      if (provisionDigest(await NodeFSP.readFile(artifactPath)) !== artifact.sha256)
        throw new Error("Stored runtime artifact changed.");
      const files: Array<typeof File.Type> = [...submitted];
      for (const scope of ["home", "workspace"] as const) {
        for (const configured of provisioning[scope === "home" ? "homeFiles" : "workspaceFiles"] ??
          []) {
          files.push(
            file(scope, configured.destination, await NodeFSP.readFile(configured.source)),
          );
        }
      }
      const driver = input.agentDriver ?? "codex";
      const credentialTarget =
        driver === "cursor" ? ".config/cursor/auth.json" : ".codex/auth.json";
      if (driver === "codex" || driver === "cursor") {
        const credential = await NodeFSP.readFile(
          accountAuthPath(input.providerInstanceId, home),
        ).catch(() => {
          throw new ProvisionRefused(
            "credentials",
            "The selected provider account has no credentials on this manager.",
          );
        });
        const duplicate = files.findIndex(
          (item) => item.scope === "home" && item.destination === credentialTarget,
        );
        if (duplicate !== -1) files.splice(duplicate, 1);
        files.push(file("home", credentialTarget, credential));
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
        enableChildProvider(
          settings,
          driver,
          input.providerInstanceId,
          `/tmp/t3-provision/${input.requestId}/home`,
        ),
      );
      const parsedSettings = decodeSettings(configuredSettings);
      const environment = [];
      for (const variable of provisioning.shellEnvironment ?? []) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) ||
          ["HOME", "T3CODE_HOME"].includes(variable.name)
        )
          throw new ProvisionRefused(
            "unconfigured",
            "A configured environment variable would change the isolated home.",
          );
        environment.push({
          name: variable.name,
          value: (await NodeFSP.readFile(variable.source, "utf8")).trim(),
          sensitive: true,
        });
      }
      const selected = parsedSettings.providerInstances[input.providerInstanceId] ?? {};
      const resultSettings = {
        ...decodeSettingsRecord(configuredSettings),
        ...parsedSettings,
        providerInstances: {
          ...parsedSettings.providerInstances,
          [input.providerInstanceId]: {
            ...selected,
            environment: [
              ...environment,
              ...(driver === "cursor"
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
          throw new ProvisionRefused(
            "unconfigured",
            "Provisioning files contain duplicate destinations.",
          );
        destinations.add(destination);
      }
      const preparation = {
        requestId: input.requestId,
        root: `/tmp/t3-provision/${input.requestId}`,
        repository,
        artifact: {
          archivePath: `/tmp/t3-runtime-${artifact.sha256}.tar`,
          sha256: artifact.sha256,
          revision: artifact.revision,
          entrypoint: artifact.entrypoint,
          ...(artifact.install ? { install: artifact.install } : {}),
        },
        runtimeExecutable: artifact.runtimeExecutable,
        port: 3773,
        readinessTimeoutSeconds: 180,
        brokerTtl: "7d",
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
      };
      let request: DurableProvisionRequest;
      if (input.provider === "e2b") {
        if (!provisioning.templateId)
          throw new ProvisionRefused(
            "unconfigured",
            "Configure an E2B template before provisioning.",
          );
        request = {
          ...common,
          provider: "e2b",
          templateId: await resolver.template(provisioning.templateId),
          strategy: "fork",
        };
      } else {
        if (!provisioning.namespace)
          throw new ProvisionRefused("unconfigured", "Configure Namespace before provisioning.");
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
