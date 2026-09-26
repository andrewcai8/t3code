// @effect-diagnostics nodeBuiltinImport:off - portable credentials are resolved at the provisioning boundary.
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
import { rankAccounts, type AccountLoad } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  codexLoginExpiredMessage,
  codexLoginExpiring,
  parseCodexLogin,
} from "../provider/codexLoginCopy.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { cursorFileCredentialPath } from "../provider/cursorCredentialPath.ts";
import type { Provisioning } from "./config.ts";
import { credentialDestinations } from "./credentialDestinations.ts";

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
    // Every environment gets a copy that cannot refresh (`stripCodexRefreshToken`),
    // so its access token must outlive the run.
    if (kind === "codex") {
      const login = parseCodexLogin(
        yield* fs.readFileString(source).pipe(Effect.orElseSucceed(() => "")),
      );
      if (codexLoginExpiring(login, yield* Clock.currentTimeMillis))
        return yield* new ProvisionRefused({
          reason: "credentials",
          message: codexLoginExpiredMessage(instance.displayName ?? instanceId),
        });
    }
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
 * Each driver runs on its account with the largest share of usage left once
 * its active sessions are counted (`rankAccounts`), walking down the ranking past any account whose login cannot leave this
 * machine or would expire before the run could use it. The requested driver must resolve to some account; every other
 * driver comes along when one of its accounts is portable and is left off
 * the guest otherwise, so one unusable login never blocks the chat asked for.
 * `providerInstanceId` names the driver when `agentDriver` is absent and wins
 * ties, which keeps a manager with no usage data on the account the user saw.
 * `pinAccount` skips the ranking for the requested driver and runs on
 * `providerInstanceId` or refuses.
 */
export type ProvisioningProviderProfiles = readonly [
  primary: ProvisioningProviderProfile,
  ...companions: ProvisioningProviderProfile[],
];

export const resolveProvisioningProfiles = Effect.fn("resolveProvisioningProfiles")(function* (
  settings: ServerSettings,
  input: {
    readonly providerInstanceId: string;
    readonly agentDriver?: string | undefined;
    readonly pinAccount?: boolean | undefined;
  },
  claudeOAuthTokens: Provisioning["claudeOAuthTokens"] | undefined,
  usage: {
    readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "usageLimits">>;
    readonly now: number;
    readonly load?: AccountLoad;
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
      usage.load,
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
  const routed =
    driver === undefined || input.pinAccount ? Option.none() : yield* firstPortable(driver);
  const primary = Option.isSome(routed)
    ? routed.value
    : yield* resolveProvisioningProviderProfile(
        settings,
        { providerInstanceId: input.providerInstanceId, agentDriver: input.agentDriver },
        claudeOAuthTokens,
      );
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
