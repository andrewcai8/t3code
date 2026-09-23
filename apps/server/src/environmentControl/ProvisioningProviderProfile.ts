// @effect-diagnostics nodeBuiltinImport:off - portable credentials are resolved at the provisioning boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { rankAccounts } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { cursorFileCredentialPath } from "../provider/cursorCredentialPath.ts";
import { canonicalRepository, type Provisioning } from "./config.ts";

export class ProvisionRefused extends Schema.TaggedError<ProvisionRefused>()("ProvisionRefused", {
  reason: Schema.Literals(["unconfigured", "credentials", "unsupported"]),
  message: Schema.String,
}) {}

export interface ProvisioningProviderProfile {
  readonly kind: "codex" | "cursor" | "claudeAgent";
  readonly instanceId: ProviderInstanceId;
  readonly displayName?: string;
  readonly environment: ProviderInstanceEnvironment;
  readonly credential:
    | { readonly kind: "file"; readonly source: string; readonly destination: string }
    | { readonly kind: "environment" };
}

export const credentialVariables = {
  codex: ["OPENAI_API_KEY"],
  cursor: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
  claudeAgent: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
};

/**
 * Where each driver reads its login inside a provisioned home, relative to it.
 *
 * The counterpart of `credentialVariables`: whichever of these a provisioned
 * environment gets, it must not get both. A CLI that finds a credential file
 * prefers it over the variables, so a file left behind by a home-file copy
 * silently replaces the credential provisioning selected.
 */
export const credentialDestinations = {
  codex: [".codex/auth.json"],
  cursor: [".cursor/auth.json", ".config/cursor/auth.json"],
  claudeAgent: [".claude/.credentials.json"],
};

/**
 * Where the selected account's credential file belongs inside a guest home.
 *
 * Cursor's file credential store is platform-specific: a Linux guest reads
 * `.config/cursor/auth.json` while a macOS one reads `.cursor/auth.json`. The
 * manager resolves the source path from its own platform, so the destination
 * has to be restated for the machine the credential is going to.
 */
export const guestCredentialDestination = (
  kind: keyof typeof credentialDestinations,
  destination: string,
  provider: "e2b" | "namespace",
) => (kind === "cursor" && provider === "e2b" ? ".config/cursor/auth.json" : destination);

/**
 * Whether a variable is the login of a driver outside `kinds`.
 *
 * An operator's `shellEnvironment` holds a key per account they provision
 * with. A driver an environment does not run has nothing to do with its key,
 * and each enabled account carries only its own driver's.
 */
export const isForeignCredentialVariable = (
  kinds: ReadonlyArray<ProvisioningProviderProfile["kind"]>,
  name: string,
) =>
  Object.entries(credentialVariables).some(
    ([driver, names]) =>
      !kinds.includes(driver as ProvisioningProviderProfile["kind"]) && names.includes(name),
  );

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCursorSettings = Schema.decodeUnknownEffect(CursorSettings);

export const resolveProvisioningProviderProfile = Effect.fn("resolveProvisioningProviderProfile")(
  function* (
    settings: ServerSettings,
    input: { readonly providerInstanceId: string; readonly agentDriver?: string | undefined },
    claudeOAuthTokens?: Provisioning["claudeOAuthTokens"],
  ) {
    const instanceId = ProviderInstanceId.make(input.providerInstanceId);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!instance || (input.agentDriver !== undefined && instance.driver !== input.agentDriver))
      return yield* new ProvisionRefused({
        reason: "credentials",
        message: "The selected provider account is unavailable on this machine.",
      });
    const environment = instance.environment ?? [];
    const named = instance.displayName ? { displayName: instance.displayName } : {};
    const selectedEnvironment = mergeProviderInstanceEnvironment(environment, {});
    const effectiveEnvironment = mergeProviderInstanceEnvironment(environment);
    const invalidConfig = () =>
      new ProvisionRefused({
        reason: "unconfigured",
        message: "The selected provider account has invalid settings.",
      });
    let kind: ProvisioningProviderProfile["kind"];
    let source: string;
    let destination: string;
    let enabled: boolean;
    let claudeLoginDirectory: string | undefined;
    switch (instance.driver) {
      case "codex": {
        kind = "codex";
        const config = yield* decodeCodexSettings(instance.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        );
        enabled = instance.enabled ?? config.enabled;
        const layout = yield* resolveCodexHomeLayout(config);
        source = NodePath.join(layout.effectiveHomePath ?? layout.sharedHomePath, "auth.json");
        destination = ".codex/auth.json";
        break;
      }
      case "cursor": {
        kind = "cursor";
        const config = yield* decodeCursorSettings(instance.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        );
        enabled = instance.enabled ?? config.enabled;
        source = cursorFileCredentialPath(effectiveEnvironment, yield* HostProcessPlatform);
        destination = ".cursor/auth.json";
        break;
      }
      case "claudeAgent": {
        kind = "claudeAgent";
        const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        );
        enabled = instance.enabled ?? config.enabled;
        const home = yield* resolveClaudeHomePath(config);
        const configDir = config.homePath.trim()
          ? home
          : effectiveEnvironment.CLAUDE_CONFIG_DIR || NodePath.join(home, ".claude");
        source = NodePath.join(configDir, ".credentials.json");
        claudeLoginDirectory =
          config.homePath.trim() || effectiveEnvironment.CLAUDE_CONFIG_DIR ? configDir : undefined;
        destination = ".claude/.credentials.json";
        break;
      }
      default:
        return yield* new ProvisionRefused({
          reason: "unsupported",
          message: "This provider does not support cloud provisioning.",
        });
    }
    if (!enabled)
      return yield* new ProvisionRefused({
        reason: "credentials",
        message: "The selected provider account is disabled.",
      });
    if (
      kind !== "codex" &&
      credentialVariables[kind].some((name) => selectedEnvironment[name]?.trim())
    )
      return {
        kind,
        instanceId,
        ...named,
        environment,
        credential: { kind: "environment" },
      } satisfies ProvisioningProviderProfile;
    const cloudToken = kind === "claudeAgent" ? claudeOAuthTokens?.[instanceId] : undefined;
    if (cloudToken)
      return {
        kind,
        instanceId,
        ...named,
        environment: [
          ...environment,
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: cloudToken, sensitive: true },
        ],
        credential: { kind: "environment" },
      } satisfies ProvisioningProviderProfile;
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(source).pipe(
      Effect.mapError(
        () =>
          new ProvisionRefused({
            reason: "credentials",
            message: "The selected account credentials could not be read.",
          }),
      ),
    );
    if (!exists)
      return yield* new ProvisionRefused({
        reason: "credentials",
        message:
          kind === "claudeAgent"
            ? `This Claude account stores its login in the macOS keychain, which can't be copied safely. Run \`${claudeLoginDirectory ? `CLAUDE_CONFIG_DIR=${claudeLoginDirectory} ` : ""}claude setup-token\` and add the token under provisioning.claudeOAuthTokens.${instanceId} in environment-control.json.`
            : "The selected account credentials could not be found on this machine.",
      });
    return {
      kind,
      instanceId,
      ...named,
      environment,
      credential: { kind: "file", source, destination },
    } satisfies ProvisioningProviderProfile;
  },
);

/**
 * The accounts a new cloud environment runs, the routed one first.
 *
 * Each driver runs on its account with the most usage left (`rankAccounts`),
 * walking down the ranking past any account whose login cannot leave this
 * machine. The requested driver must resolve to some account; every other
 * driver comes along when one of its accounts is portable and is left off
 * the guest otherwise, so one unusable login never blocks the chat asked for.
 * `providerInstanceId` names the driver when `agentDriver` is absent and wins
 * ties, which keeps a manager with no usage data on the account the user saw.
 */
export type ProvisioningProviderProfiles = readonly [
  primary: ProvisioningProviderProfile,
  ...companions: ProvisioningProviderProfile[],
];

export const resolveProvisioningProfiles = Effect.fn("resolveProvisioningProfiles")(function* (
  settings: ServerSettings,
  input: { readonly providerInstanceId: string; readonly agentDriver?: string | undefined },
  claudeOAuthTokens: Provisioning["claudeOAuthTokens"] | undefined,
  usage: {
    readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "usageLimits">>;
    readonly now: number;
  },
) {
  const instances = deriveProviderInstanceConfigMap(settings);
  const hint = ProviderInstanceId.make(input.providerInstanceId);
  const limits = new Map(usage.providers.map((provider) => [provider.instanceId, provider]));
  const ranked = (driver: string) =>
    rankAccounts(
      Object.entries(instances).flatMap(([id, instance]) =>
        instance.driver === driver
          ? [
              {
                instanceId: ProviderInstanceId.make(id),
                driver: instance.driver,
                usageLimits: limits.get(ProviderInstanceId.make(id))?.usageLimits,
              },
            ]
          : [],
      ),
      usage.now,
      hint,
    ).map(({ instanceId }) => instanceId);
  const firstPortable = Effect.fnUntraced(function* (driver: string) {
    const refusals = [];
    for (const instanceId of ranked(driver)) {
      const profile = yield* Effect.result(
        resolveProvisioningProviderProfile(
          settings,
          { providerInstanceId: instanceId, agentDriver: driver },
          claudeOAuthTokens,
        ),
      );
      if (profile._tag === "Success") return Option.some(profile.success);
      refusals.push({ instanceId, failure: profile.failure });
    }
    // The hinted account's refusal carries the fix the user can act on.
    const refusal = refusals.find(({ instanceId }) => instanceId === hint) ?? refusals[0];
    return refusal
      ? yield* Effect.fail(refusal.failure)
      : Option.none<ProvisioningProviderProfile>();
  });
  const driver = input.agentDriver ?? instances[hint]?.driver;
  const routed = driver === undefined ? Option.none() : yield* firstPortable(driver);
  const primary = Option.isSome(routed)
    ? routed.value
    : yield* resolveProvisioningProviderProfile(settings, input, claudeOAuthTokens);
  const companions: ProvisioningProviderProfile[] = [];
  for (const companionDriver of Object.keys(credentialVariables)) {
    if (companionDriver === primary.kind) continue;
    const companion = yield* firstPortable(companionDriver).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(companion)) companions.push(companion.value);
    else yield* Effect.logInfo(`Provisioning without ${companionDriver}: no account is usable.`);
  }
  const profiles: ProvisioningProviderProfiles = [primary, ...companions];
  return profiles;
});

export async function resolvePreparation(
  profile: ProvisioningProviderProfile,
  provisioning: Provisioning,
  provider: "e2b" | "namespace",
  repository?: string,
) {
  const canonical = repository ? canonicalRepository(repository) : undefined;
  const selected = canonical
    ? provisioning.repositories?.find(
        (entry) => canonicalRepository(entry.repository) === canonical,
      )
    : undefined;
  const setup = selected?.[provider];
  const defaults = provider === "namespace" ? provisioning.namespace : undefined;
  const home = provider === "e2b" ? "/home/user" : "/Users/runner";
  const files = new Map<string, { source: string; destination: string; mode: string }>();
  for (const file of [
    ...(provisioning.homeFiles ?? []),
    ...(profile.credential.kind === "file" ? [profile.credential] : []),
  ]) {
    const destination = NodePath.posix.normalize(
      file.destination.replace(/^\/(?:Users\/runner|home\/user)\//, ""),
    );
    if (
      NodePath.posix.isAbsolute(destination) ||
      destination === ".." ||
      destination.startsWith("../") ||
      destination === "." ||
      file.destination.includes("\\") ||
      file.destination.includes("\0") ||
      file.destination.split("/").includes("..")
    )
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: "A configured home file escapes the workspace home.",
      });
    if (files.has(destination) && file !== profile.credential)
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: "Configured home file destinations must be unique.",
      });
    files.set(destination, { source: file.source, destination, mode: "600" });
  }
  if (profile.credential.kind === "file") {
    const from = profile.credential.destination;
    const to = guestCredentialDestination(profile.kind, from, provider);
    const credential = files.get(from);
    if (to !== from && credential) {
      files.delete(from);
      files.set(to, { ...credential, destination: to });
    }
  }
  if (profile.credential.kind === "environment")
    for (const destination of credentialDestinations[profile.kind]) files.delete(destination);
  const paths = {
    HOME: home,
    PATH: `${home}/.local/bin:${home}/.bun/bin:${provider === "namespace" ? "/opt/homebrew/bin:" : ""}/usr/local/bin:/usr/bin:/bin`,
    XDG_CONFIG_HOME: `${home}/.config`,
    ...(profile.kind === "codex" ? { CODEX_HOME: `${home}/.codex` } : {}),
    ...(profile.kind === "claudeAgent" ? { CLAUDE_CONFIG_DIR: `${home}/.claude` } : {}),
    ...(profile.kind === "cursor"
      ? {
          AGENT_CLI_CREDENTIAL_STORE: "file",
          CURSOR_CONFIG_DIR: `${home}/${provider === "e2b" ? ".config/cursor" : ".cursor"}`,
        }
      : {}),
  };
  const selectedNames = new Set([
    ...credentialVariables[profile.kind],
    ...profile.environment.map(({ name }) => name),
    ...Object.keys(paths),
  ]);
  const environment = new Map<string, { name: string; value: string; sensitive: boolean }>();
  for (const variable of provisioning.shellEnvironment ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name))
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: "A configured environment variable name is invalid.",
      });
    if (
      selectedNames.has(variable.name) ||
      isForeignCredentialVariable([profile.kind], variable.name)
    )
      continue;
    const value = (
      await NodeFSP.readFile(variable.source, "utf8").catch(() => {
        throw new ProvisionRefused({
          reason: "unconfigured",
          message: `The source for ${variable.name} could not be read.`,
        });
      })
    ).replace(/\r?\n$/, "");
    if (!value)
      throw new ProvisionRefused({
        reason: "credentials",
        message: `The source for ${variable.name} is empty.`,
      });
    environment.set(variable.name, { name: variable.name, value, sensitive: true });
  }
  for (const name of credentialVariables[profile.kind])
    environment.set(name, { name, value: "", sensitive: true });
  for (const variable of profile.environment) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name))
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: "A selected environment variable name is invalid.",
      });
    environment.set(variable.name, variable);
  }

  for (const [name, value] of Object.entries(paths))
    environment.set(name, { name, value, sensitive: false });
  const workspaceFiles = selected?.workspaceFiles ?? provisioning.workspaceFiles ?? [];
  const destinations = new Set<string>();
  for (const file of workspaceFiles) {
    const destination = NodePath.posix.normalize(file.destination);
    if (
      NodePath.posix.isAbsolute(destination) ||
      destination === "." ||
      file.destination.includes("\\") ||
      file.destination.includes("\0") ||
      file.destination.split("/").includes("..") ||
      destinations.has(destination)
    )
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: "Workspace file destinations must be unique paths within the checkout.",
      });
    destinations.add(destination);
  }
  for (const file of [...files.values(), ...workspaceFiles]) {
    await NodeFSP.access(file.source).catch(() => {
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: `Configured file '${file.source}' could not be read.`,
      });
    });
  }
  return {
    profile,
    files: [...files.values()],
    environment: [...environment.values()],
    workspaceFiles,
    prepareCommands: setup?.prepareCommands ?? defaults?.prepareCommands ?? [],
    verifyCommands: setup?.verifyCommands ?? defaults?.verifyCommands ?? [],
    artifacts:
      provider === "namespace" ? (selected?.namespace?.artifacts ?? defaults?.artifacts ?? []) : [],
  };
}
