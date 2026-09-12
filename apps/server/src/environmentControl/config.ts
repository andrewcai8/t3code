// @effect-diagnostics nodeBuiltinImport:off - private configuration is loaded at the Promise-based SDK boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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
/**
 * What an install needs to create environments on demand, as opposed to
 * controlling ones it already declares. Absent on a machine that only manages
 * named targets, which is why provisioning refuses with `unconfigured` rather
 * than failing.
 */
const Provisioning = Schema.Struct({
  templateId: Schema.optional(TrimmedNonEmptyString),
  /** Required only for cloning private repositories into a new environment. */
  githubToken: Schema.optional(TrimmedNonEmptyString),
  /**
   * Files copied into a new environment's checkout, by path within it.
   *
   * A clone is not a working tree: a backend needs its dotenv before anything
   * runs. These are named one by one rather than discovered, because the files
   * worth copying here are exactly the ones a repository refuses to carry, and
   * an environment holding them can reach whatever they unlock.
   */
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
  workspaceFiles: Schema.optional(
    Schema.Array(
      Schema.Struct({
        /** Absolute path on the machine running the server. */
        source: TrimmedNonEmptyString,
        /** Path relative to the checkout root. */
        destination: TrimmedNonEmptyString,
      }),
    ),
  ),
  /** Namespace Devbox defaults. Present only when on-demand Mac provisioning is enabled. */
  namespace: Schema.optional(
    Schema.Struct({
      size: TrimmedNonEmptyString,
      region: Schema.optional(TrimmedNonEmptyString),
      idleTimeoutMinutes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
});
export type Provisioning = typeof Provisioning.Type;

export const EnvironmentControlConfig = Schema.Struct({
  e2bApiKey: TrimmedNonEmptyString,
  provisioning: Schema.optional(Provisioning),
  namespaceToken: Schema.optional(TrimmedNonEmptyString),
  namespaceIngressToken: Schema.optional(TrimmedNonEmptyString),
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

export const CONTROL_CONFIG_FILENAME = "environment-control.json";

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
 * The default lives beside `settings.json` in the state directory, with the
 * machine-level `~/.t3` location as a fallback for desktop dev runs that use an
 * isolated state directory. An explicit override is returned even when the file
 * is missing: naming a path that does not exist is a misconfiguration and has to
 * fail loudly, whereas the default being absent just means a machine has no
 * cloud controls.
 */
export async function resolveControlConfigPath(input: {
  readonly explicit?: string | undefined;
  readonly stateDir: string;
  readonly fallback?: string | undefined;
  readonly exists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
  const explicit = input.explicit?.trim();
  if (explicit) return explicit;
  const candidates = [
    NodePath.join(input.stateDir, CONTROL_CONFIG_FILENAME),
    input.fallback ?? NodePath.join(NodeOS.homedir(), ".t3", CONTROL_CONFIG_FILENAME),
  ];
  const exists = input.exists ?? onDisk;
  for (const path of candidates) {
    if (await exists(path)) return path;
  }
  return null;
}
