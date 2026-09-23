// @effect-diagnostics nodeBuiltinImport:off - a plain planner for a deploy script, outside Effect.
/**
 * Decides which of the operator's provider accounts travel to a provisioning
 * manager, and what the manager needs on disk so that
 * `resolveProvisioningProviderProfile`, running on the manager, resolves each
 * account to the same credential the laptop would.
 *
 * The manager is a Linux box, and that function resolves credential paths from
 * the platform it runs on. So sources are resolved here with the host's
 * platform, and every destination is the path a Linux process reads. Cursor
 * is the one that differs: macOS reads `.cursor/auth.json`, Linux reads
 * `$XDG_CONFIG_HOME/cursor/auth.json`.
 */
import * as NodePath from "node:path";

import { cursorFileCredentialPath } from "../../apps/server/src/provider/cursorCredentialPath.ts";

const SLUG = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BUILT_IN = ["codex", "claudeAgent", "cursor"] as const;

interface EnvironmentVariable {
  readonly name: string;
  readonly value?: string;
  readonly sensitive?: boolean;
}

interface HostInstance {
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly environment?: ReadonlyArray<EnvironmentVariable>;
  readonly config?: unknown;
}

export interface PlanInput {
  /** The host's `settings.json`, as written. */
  readonly settings: {
    readonly providers?: Record<string, { readonly enabled?: boolean } | undefined>;
    readonly providerInstances?: Record<string, HostInstance | undefined>;
  };
  /** The host's `provisioning` section of `environment-control.json`. */
  readonly provisioning: {
    readonly claudeOAuthTokens?: Record<string, string>;
    readonly shellEnvironment?: ReadonlyArray<{ readonly name: string; readonly source: string }>;
  };
  /** Instance ids to carry; absent means every account that can travel. */
  readonly accounts?: ReadonlyArray<string> | undefined;
  readonly host: {
    readonly homedir: string;
    readonly platform: NodeJS.Platform;
    readonly environment: Record<string, string | undefined>;
  };
  /** The manager's `--base-dir`; its state directory is `userdata` below it. */
  readonly managerBaseDir: string;
}

export interface ManagerPlan {
  readonly accounts: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /** Host files to copy, by absolute source and absolute manager destination. */
  readonly files: ReadonlyArray<{ readonly source: string; readonly destination: string }>;
  readonly settingsPath: string;
  readonly providerInstances: Record<string, ManagerInstance>;
  readonly shellEnvironment?: ReadonlyArray<{ readonly name: string; readonly source: string }>;
}

export interface ManagerInstance {
  readonly driver: string;
  readonly displayName?: string;
  readonly enabled: true;
  readonly environment?: ReadonlyArray<Required<EnvironmentVariable>>;
  readonly config?: { readonly homePath: string };
}

const expandHome = (value: string, homedir: string) =>
  value === "~"
    ? homedir
    : value.startsWith("~/") || value.startsWith("~\\")
      ? NodePath.join(homedir, value.slice(2))
      : value;

const trimmed = (config: unknown, key: string) => {
  const value =
    typeof config === "object" && config !== null && key in config
      ? (config as Record<string, unknown>)[key]
      : undefined;
  return typeof value === "string" ? value.trim() : "";
};

const configEnabled = (config: unknown) =>
  typeof config === "object" && config !== null && "enabled" in config
    ? (config as { enabled?: unknown }).enabled
    : undefined;

/** Mirrors `resolveCodexHomeLayout`: the shadow home, else the home, else `~/.codex`. */
const codexAuthSource = (config: unknown, homedir: string) => {
  const shadow = trimmed(config, "shadowHomePath");
  const home = trimmed(config, "homePath");
  const effective = shadow
    ? NodePath.resolve(expandHome(shadow, homedir))
    : home
      ? NodePath.resolve(expandHome(home, homedir))
      : NodePath.join(homedir, ".codex");
  return NodePath.join(effective, "auth.json");
};

/**
 * Mirrors `deriveProviderInstanceConfigMap`: a built-in driver without an
 * explicit instance is still an instance, configured by the legacy map.
 */
const hostInstances = (settings: PlanInput["settings"]) => {
  const merged: Record<string, HostInstance> = {};
  for (const [id, instance] of Object.entries(settings.providerInstances ?? {}))
    if (instance) merged[id] = instance;
  for (const driver of BUILT_IN)
    if (!(driver in merged))
      merged[driver] = { driver, config: settings.providers?.[driver] ?? {} };
  return merged;
};

export function planManagerAccounts(input: PlanInput): ManagerPlan {
  const base = input.managerBaseDir;
  const posix = NodePath.posix;
  const instances = hostInstances(input.settings);
  const requested = input.accounts ? new Set(input.accounts) : undefined;
  for (const id of requested ?? [])
    if (!(id in instances)) throw new Error(`Unknown provider account '${id}'`);

  const accounts: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const files: Array<{ source: string; destination: string }> = [];
  const providerInstances: Record<string, ManagerInstance> = {};

  for (const [id, instance] of Object.entries(instances)) {
    if (requested && !requested.has(id)) continue;
    const skip = (reason: string) => {
      if (requested) throw new Error(`Provider account '${id}' cannot travel: ${reason}`);
      skipped.push({ id, reason });
    };
    if (!SLUG.test(id)) {
      skip("the instance id is not a valid slug");
      continue;
    }
    const named = instance.displayName ? { displayName: instance.displayName } : {};
    // Same precedence as resolveProvisioningProviderProfile; Cursor is off
    // unless enabled, the others are on unless disabled.
    const enabled =
      instance.enabled ?? configEnabled(instance.config) ?? instance.driver !== "cursor";
    if (!enabled) {
      skip("the account is disabled");
      continue;
    }
    switch (instance.driver) {
      case "codex": {
        const homePath = posix.join(base, "codex-homes", id);
        files.push({
          source: codexAuthSource(instance.config, input.host.homedir),
          destination: posix.join(homePath, "auth.json"),
        });
        providerInstances[id] = { driver: "codex", ...named, enabled: true, config: { homePath } };
        break;
      }
      case "claudeAgent": {
        // A keychain login cannot be copied; only a setup-token travels. It
        // rides in the instance's own environment, so the manager's Claude
        // runs on it too, and provisioning hands the same variable on.
        const token = input.provisioning.claudeOAuthTokens?.[id];
        if (!token) {
          skip("no provisioning.claudeOAuthTokens entry; run `claude setup-token` for it");
          continue;
        }
        providerInstances[id] = {
          driver: "claudeAgent",
          ...named,
          enabled: true,
          environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: token, sensitive: true }],
        };
        break;
      }
      case "cursor": {
        const home = posix.join(base, "cursor-homes", id);
        const environment = { ...input.host.environment };
        for (const variable of instance.environment ?? [])
          environment[variable.name] = variable.value ?? "";
        files.push({
          source: cursorFileCredentialPath(environment, input.host.platform, input.host.homedir),
          destination: posix.join(home, ".config", "cursor", "auth.json"),
        });
        providerInstances[id] = {
          driver: "cursor",
          ...named,
          enabled: true,
          environment: [
            { name: "HOME", value: home, sensitive: false },
            // Pinned so an ambient XDG_CONFIG_HOME on the manager cannot
            // redirect the lookup away from this account's home.
            { name: "XDG_CONFIG_HOME", value: posix.join(home, ".config"), sensitive: false },
            {
              name: "CURSOR_CONFIG_DIR",
              value: posix.join(home, ".config", "cursor"),
              sensitive: false,
            },
            { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
          ],
        };
        break;
      }
      default:
        skip(`the ${instance.driver} driver does not provision cloud environments`);
        continue;
    }
    accounts.push(id);
  }

  // `shellEnvironment` names a source path on the host, and freezing a
  // manifest reads every one, so the value is carried as a file the manager
  // owns and the entry re-pointed at it.
  const shellEnvironment = input.provisioning.shellEnvironment?.map((variable) => {
    if (!VARIABLE_NAME.test(variable.name))
      throw new Error(`shellEnvironment names an invalid variable '${variable.name}'`);
    const destination = posix.join(base, "shell-environment", variable.name);
    files.push({ source: variable.source, destination });
    return { name: variable.name, source: destination };
  });

  return {
    accounts,
    skipped,
    files,
    settingsPath: posix.join(base, "userdata", "settings.json"),
    providerInstances,
    ...(shellEnvironment?.length ? { shellEnvironment } : {}),
  };
}
