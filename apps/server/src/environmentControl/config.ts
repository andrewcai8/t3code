// @effect-diagnostics nodeBuiltinImport:off - private configuration is loaded at the Promise-based SDK boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export function canonicalRepository(repository: string): string {
  const cleaned = repository
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(cleaned))
    throw new Error("Repository must look like owner/name");
  return cleaned.toLowerCase();
}

const RelativeFilePath = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      !NodePath.posix.isAbsolute(path) &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== "..") &&
      NodePath.posix.normalize(path) !== ".",
  ),
);
const WorkspaceFile = Schema.Struct({
  source: TrimmedNonEmptyString,
  destination: RelativeFilePath,
});
const Commands = {
  prepareCommands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  verifyCommands: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
};
/**
 * A Namespace prepare command. `background: true` marks one that starts a service for the chat,
 * such as a dev server or a simulator, rather than preparing its checkout: an instance-engine
 * template builder runs no chat, so it skips these. Chats run every command as written.
 */
const NamespacePrepareCommand = Schema.Union([
  TrimmedNonEmptyString,
  Schema.Struct({ command: TrimmedNonEmptyString, background: Schema.optional(Schema.Boolean) }),
]);
export type NamespacePrepareCommand = typeof NamespacePrepareCommand.Type;
const NamespaceCommands = {
  ...Commands,
  prepareCommands: Schema.optional(Schema.Array(NamespacePrepareCommand)),
};
export const commandLine = (entry: NamespacePrepareCommand) =>
  typeof entry === "string" ? entry : entry.command;
export const isBackground = (entry: NamespacePrepareCommand) =>
  typeof entry !== "string" && entry.background === true;

const E2bIdentity = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  metadata: Schema.Record(Schema.String, Schema.String),
});
const Target = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  hostId: TrimmedNonEmptyString,
  operatorToken: TrimmedNonEmptyString,
  machine: Schema.Union([
    Schema.Struct({ provider: Schema.Literal("e2b"), ...E2bIdentity.fields }),
    Schema.Struct({
      provider: Schema.Literal("namespace"),
      name: TrimmedNonEmptyString,
      devboxId: TrimmedNonEmptyString,
      volumeName: TrimmedNonEmptyString,
      region: TrimmedNonEmptyString,
    }),
  ]),
});
export const NamespaceArtifact = Schema.Struct({
  path: TrimmedNonEmptyString,
  destination: TrimmedNonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type NamespaceArtifact = typeof NamespaceArtifact.Type;
/**
 * What an install needs to create environments on demand, as opposed to
 * controlling ones it already declares. Absent on a machine that only manages
 * named targets, which is why provisioning refuses with `unconfigured` rather
 * than failing.
 */
export const ProvisionRuntimeArtifact = Schema.Struct({
  path: TrimmedNonEmptyString,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  entrypoint: TrimmedNonEmptyString,
  runtimeExecutable: TrimmedNonEmptyString,
  /**
   * Install package dependencies on the target platform before starting T3.
   * Linux/E2B artifacts should omit this and ship `node_modules`; sandboxes
   * often cannot reach nodejs.org to compile native addons.
   */
  install: Schema.optional(Schema.Literal("npm")),
});
export type ProvisionRuntimeArtifact = typeof ProvisionRuntimeArtifact.Type;
const Provisioning = Schema.Struct({
  templateId: Schema.optional(TrimmedNonEmptyString),
  runtimeArtifacts: Schema.optional(
    Schema.Struct({
      linux: Schema.optional(ProvisionRuntimeArtifact),
      macos: Schema.optional(ProvisionRuntimeArtifact),
    }),
  ),
  /** Required only for cloning private repositories into a new environment. */
  githubToken: Schema.optional(TrimmedNonEmptyString),
  /**
   * `claude setup-token` values by Claude provider instance id, installed only
   * in cloud environments.
   *
   * A keychain login cannot be copied: Claude Code rotates its refresh token,
   * so two machines holding one login fork the chain and one is signed out.
   * A setup-token does not rotate, and keeping it here rather than in the
   * instance environment leaves local runs on the keychain login.
   */
  claudeOAuthTokens: Schema.optional(Schema.Record(Schema.String, TrimmedNonEmptyString)),
  /**
   * Hosts a new environment may reach. Everything else is denied.
   *
   * An agent with a shell can read any credential the environment holds, so
   * the useful control is not hiding values but bounding where they can go.
   * Absent, the environment reaches the whole internet, which is E2B's
   * default; listing hosts turns that into deny-by-default.
   *
   * Host rules cover HTTP and HTTPS. Anything speaking another protocol — a
   * database wire protocol, say — needs its address listed as a CIDR instead.
   */
  egressAllow: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Environment variables written into a new environment's shell profile.
   *
   * Some agents read their credential from the environment rather than a file,
   * and a sandbox command does not inherit anything the template was built
   * with, so the value has to be placed where a shell will find it.
   */
  shellEnvironment: Schema.optional(
    Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, source: TrimmedNonEmptyString })),
  ),
  /**
   * Files placed in a new environment's home directory, by path within it.
   *
   * Agent CLIs keep their sign-in where they expect to find it, and each keeps
   * it somewhere different. Copying those files is what makes an environment
   * usable by more than the one agent whose credentials provisioning knows how
   * to install, and saves signing in again on every machine.
   */
  homeFiles: Schema.optional(
    Schema.Array(
      Schema.Struct({
        /** Absolute path on the machine running the server. */
        source: TrimmedNonEmptyString,
        /** Path relative to the environment's home directory. */
        destination: TrimmedNonEmptyString,
      }),
    ),
  ),
  /** Files copied into the checkout unless its repository entry overrides them. */
  workspaceFiles: Schema.optional(Schema.Array(WorkspaceFile)),
  repositories: Schema.optional(
    Schema.Array(
      Schema.Struct({
        repository: TrimmedNonEmptyString,
        workspaceFiles: Schema.optional(Schema.Array(WorkspaceFile)),
        e2b: Schema.optional(
          Schema.Struct({
            ...Commands,
            /**
             * Keep a warm E2B snapshot of this repository, prepared once, for
             * new chats to start from. Opt in only when the prepare commands
             * are safe to rerun on a tree they already prepared.
             */
            warm: Schema.optional(Schema.Boolean),
          }),
        ),
        namespace: Schema.optional(
          Schema.Struct({
            ...NamespaceCommands,
            artifacts: Schema.optional(Schema.Array(NamespaceArtifact)),
            /**
             * Keep one prepared, stopped Mac of this repository for the next
             * chat to claim. Opt in only when the prepare commands are safe
             * to rerun on a tree they already prepared.
             */
            spare: Schema.optional(Schema.Boolean),
            /**
             * `instance` runs new chats of this repository on per-chat compute
             * instances with a shared cache volume; `devbox` (the default) on
             * Devboxes. A chat keeps the engine it was frozen with.
             */
            engine: Schema.optional(Schema.Literals(["devbox", "instance"])),
            /**
             * Home-relative paths this repository's prepare commands rebuild, such as a
             * toolchain they install. Instance-engine snapshots leave them out and templates
             * keep them, so a chat's snapshot carries only its own state.
             */
            derivedHomePaths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
          }),
        ),
      }),
    ).check(
      Schema.makeFilter((entries) => {
        try {
          return (
            new Set(entries.map(({ repository }) => canonicalRepository(repository))).size ===
            entries.length
          );
        } catch {
          return false;
        }
      }),
    ),
  ),
  /**
   * Skill bundles copied into a new environment, by directory.
   *
   * An agent that reaches a prepared sandbox without its playbooks will
   * improvise, which is the opposite of why a bug is routed to one. Each CLI
   * reads skills from a different place, so a bundle is named once here and
   * the selected driver decides where it lands.
   */
  skills: Schema.optional(
    Schema.Array(
      Schema.Struct({
        /** Absolute directory on the machine running the server. */
        source: TrimmedNonEmptyString,
        /**
         * Directory name within the environment's skill root, for a source
         * that is one skill.
         *
         * Omitted, the source is read as a directory of skills and its
         * children land in the root directly. Every supported CLI resolves a
         * skill as `<root>/<directory>/SKILL.md` and looks no deeper, so a
         * plugin holding many skills needs the flat form to be found at all.
         */
        name: Schema.optional(TrimmedNonEmptyString),
        /**
         * An `https:` URL of a gzipped tarball whose root holds skill
         * directories. When set, the manager owns `source` and refreshes it
         * from `url` at startup and hourly, so `source` must be a path nothing
         * else writes.
         */
        url: Schema.optional(TrimmedNonEmptyString),
        /**
         * Drivers that receive this bundle. Omitted, every driver does. Two
         * bundles holding the same skill name collide in any root they share,
         * so ports of one bundle for different CLIs each name their drivers.
         */
        agents: Schema.optional(
          Schema.NonEmptyArray(Schema.Literals(["codex", "cursor", "claudeAgent"])),
        ),
      }),
    ),
  ),
  /**
   * How often, in hours, a repository's warm E2B base or Namespace spare is
   * rebuilt from its default branch. A repository gets one once its `e2b`
   * entry sets `warm` (or its `namespace` entry `spare`) and has prepare
   * commands, and a chat was created for it. Default 12; `0` disables both.
   */
  warmBaseRefreshHours: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Limits on t3_fork_run, which runs a cloud chat's jobs in throwaway copies of its machine. */
  workerForks: Schema.optional(
    Schema.Struct({
      /** Copies one chat may run at once. Default 8. */
      maxPerChat: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      /** Copies this host runs at once, across chats. Default 20. */
      maxPerHost: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      /** Longest a job may run. Default 120. */
      maxJobMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      /** Largest compressed outputs one job copies back into its chat's machine. Default 100. */
      maxCopyBackMiB: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      /**
       * Where each job uploads its logs and outputs, as `s3://bucket/prefix`, under
       * `<environmentId>/<batchId>/<job>/`. The copy uploads with the AWS credentials its chat's
       * agent has. Without it, outputs come back only with copyBack.
       */
      outputsUri: Schema.optional(TrimmedNonEmptyString.check(Schema.isPattern(/^s3:\/\/[^/]+/))),
    }),
  ),
  /** Namespace Devbox defaults. Present only when on-demand Mac provisioning is enabled. */
  namespace: Schema.optional(
    Schema.Struct({
      size: TrimmedNonEmptyString,
      region: Schema.optional(TrimmedNonEmptyString),
      idleTimeoutMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      ...NamespaceCommands,
      artifacts: Schema.optional(Schema.Array(NamespaceArtifact)),
    }),
  ),
});
export type Provisioning = typeof Provisioning.Type;

export const EnvironmentControlConfig = Schema.Struct({
  e2bApiKey: TrimmedNonEmptyString,
  provisioning: Schema.optional(Provisioning),
  namespaceToken: Schema.optional(TrimmedNonEmptyString),
  broker: Schema.Struct({
    ...E2bIdentity.fields,
    url: TrimmedNonEmptyString,
    ingressKey: TrimmedNonEmptyString,
  }),
  targets: Schema.Array(Target),
});
export type EnvironmentControlConfig = typeof EnvironmentControlConfig.Type;
export type ManagedTarget = typeof Target.Type;
const decodeConfig = Schema.decodeUnknownSync(EnvironmentControlConfig);

export async function readConfig(path: string): Promise<EnvironmentControlConfig> {
  const config = decodeConfig(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  const url = new URL(config.broker.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Controller requires a private HTTPS endpoint");
  if (
    new Set(config.targets.map((target) => target.environmentId)).size !== config.targets.length ||
    new Set(config.targets.map((target) => target.hostId)).size !== config.targets.length
  )
    throw new Error("Duplicate managed environment");
  for (const target of config.targets) {
    if (!/^[a-zA-Z0-9_-]+$/.test(target.hostId) || target.operatorToken.length < 32)
      throw new Error("Invalid controller identity");
  }
  for (const bundle of config.provisioning?.skills ?? []) {
    if (bundle.url !== undefined && (new URL(bundle.url).protocol !== "https:" || bundle.name))
      throw new Error("A skill bundle url must be HTTPS and publish a directory of skills");
  }
  for (const identity of [
    config.broker,
    ...config.targets.flatMap((target) =>
      target.machine.provider === "e2b" ? [target.machine] : [],
    ),
  ]) {
    if (!Object.keys(identity.metadata).length)
      throw new Error("Sandbox ownership metadata required");
  }
  return config;
}

const CONTROL_CONFIG_FILENAME = "environment-control.json";

const onDisk = async (path: string) => {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where to read cloud control configuration, or `null` when it is not set up.
 *
 * Prefer the file beside `settings.json` in the state directory, then the T3
 * home that owns that userdata directory (`--home-dir ~/.t3/dev` pins
 * `~/.t3/dev/environment-control.json`), then the machine-level `~/.t3` file.
 * An explicit override is returned even when the file is missing: naming a
 * path that does not exist is a misconfiguration and has to fail loudly,
 * whereas the default being absent just means a machine has no cloud controls.
 */
function controlConfigCandidates(input: {
  readonly stateDir: string;
  readonly fallback?: string | undefined;
}): string[] {
  const fallback =
    input.fallback ?? NodePath.join(NodeOS.homedir(), ".t3", CONTROL_CONFIG_FILENAME);
  const paths = [NodePath.join(input.stateDir, CONTROL_CONFIG_FILENAME)];
  // `--home-dir ~/.t3/dev` stores sqlite in userdata/ but operators put the
  // pin next to the home, not inside userdata. Skipping this step made Dev
  // silently use Alpha's ~/.t3/environment-control.json.
  if (NodePath.basename(input.stateDir) === "userdata")
    paths.push(NodePath.join(NodePath.dirname(input.stateDir), CONTROL_CONFIG_FILENAME));
  paths.push(fallback);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = NodePath.normalize(path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  return unique;
}

export async function resolveControlConfigPath(input: {
  readonly explicit?: string | undefined;
  readonly stateDir: string;
  readonly fallback?: string | undefined;
  readonly exists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const explicit = input.explicit?.trim();
  if (explicit) return explicit;
  const exists = input.exists ?? onDisk;
  for (const path of controlConfigCandidates(input)) {
    if (await exists(path)) return path;
  }
  return null;
}
