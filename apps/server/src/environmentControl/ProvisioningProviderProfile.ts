// @effect-diagnostics nodeBuiltinImport:off - portable credentials are resolved at the provisioning boundary.
import * as NodePath from "node:path";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { isAccountSpent, rankAccounts, type AccountLoad } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  CODEX_LOGIN_COPY_MIN_LIFETIME_MS,
  codexLoginExpiredMessage,
  codexLoginExpiring,
  codexLoginRefreshDue,
  parseCodexLogin,
} from "../provider/codexLoginCopy.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { credentialSecretName } from "../provider/providerCredentialName.ts";
import type { Provisioning } from "./config.ts";
import { cursorGuestLoginDestination } from "./credentialDestinations.ts";

export class ProvisionRefused extends Schema.TaggedError<ProvisionRefused>()("ProvisionRefused", {
  reason: Schema.Literals(["unconfigured", "credentials", "unsupported"]),
  message: Schema.String,
}) {}

export interface ProvisioningProviderProfile {
  readonly kind: "codex" | "cursor" | "claudeAgent";
  readonly instanceId: ProviderInstanceId;
  readonly displayName?: string;
  /** A Claude account's configured email, which its setup token cannot report. */
  readonly accountEmail?: string;
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

/** How this server holds its provider logins. */
export interface HostLogins {
  readonly localAgentRuns: boolean;
  /** Where this server's secret store keeps the logins it signed in itself, as Cursor's. */
  readonly secretsDir: string;
  /** Has Codex refresh an account's login here, one refresh or probe at a time. */
  readonly refresh: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}

export const resolveProvisioningProviderProfile = Effect.fn("resolveProvisioningProviderProfile")(
  function* (
    settings: ServerSettings,
    input: { readonly providerInstanceId: string; readonly agentDriver?: string | undefined },
    claudeOAuthTokens?: Provisioning["claudeOAuthTokens"],
    hostLogins?: HostLogins,
  ) {
    const instanceId = ProviderInstanceId.make(input.providerInstanceId);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!instance || (input.agentDriver !== undefined && instance.driver !== input.agentDriver))
      return yield* new ProvisionRefused({
        reason: "credentials",
        message: "The selected provider account is unavailable on this machine.",
      });
    const environment = instance.environment ?? [];
    let named: Pick<ProvisioningProviderProfile, "displayName" | "accountEmail"> =
      instance.displayName ? { displayName: instance.displayName } : {};
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
        // A managed login lives in T3's secret store, not auth.json, so any
        // auth.json in its home belongs to some other account.
        if (config.setupMode === "managed")
          return yield* new ProvisionRefused({
            reason: "credentials",
            message:
              "This Codex account signs in with ChatGPT through T3 Code, which cloud machines can't use. Pick a Codex account signed in with the Codex CLI.",
          });
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
        // V2 Cursor signs in through T3's secret store, never the cursor-agent CLI's files.
        source = hostLogins
          ? NodePath.join(
              hostLogins.secretsDir,
              `${credentialSecretName("cursor", instanceId)}.bin`,
            )
          : "";
        destination = cursorGuestLoginDestination;
        break;
      }
      case "claudeAgent": {
        kind = "claudeAgent";
        const config = yield* decodeClaudeSettings(instance.config ?? {}).pipe(
          Effect.mapError(invalidConfig),
        );
        enabled = instance.enabled ?? config.enabled;
        if (config.accountEmail) named = { ...named, accountEmail: config.accountEmail };
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
    // so its access token must outlive the run. A login this machine owns is
    // refreshed first when a copy would not last a day, and provisioning
    // copies the file only after this returns.
    if (kind === "codex") {
      const readLogin = fs.readFileString(source).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map(parseCodexLogin),
      );
      const context = {
        now: yield* Clock.currentTimeMillis,
        localAgentRuns: hostLogins?.localAgentRuns ?? true,
      };
      const current = yield* readLogin;
      const login =
        hostLogins && codexLoginRefreshDue(current, CODEX_LOGIN_COPY_MIN_LIFETIME_MS, context)
          ? yield* hostLogins.refresh(instanceId).pipe(Effect.andThen(readLogin))
          : current;
      if (codexLoginExpiring(login, context.now))
        return yield* new ProvisionRefused({
          reason: "credentials",
          message: codexLoginExpiredMessage(instance.displayName ?? instanceId, login, context),
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

/** How a host reads its accounts' usage when it places or moves a cloud chat. */
interface AccountUsage {
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "usageLimits"> & Partial<Pick<ServerProvider, "auth">>
  >;
  readonly now: number;
  readonly load?: AccountLoad;
}

/** One driver's accounts on this host, the one with the most usage left per session first. */
const rankDriverAccounts = (
  settings: ServerSettings,
  driver: string,
  usage: AccountUsage,
  preferred?: ProviderInstanceId,
) => {
  const limits = new Map(usage.providers.map((provider) => [provider.instanceId, provider]));
  return rankAccounts(
    Object.entries(deriveProviderInstanceConfigMap(settings)).flatMap(([id, instance]) =>
      instance.driver === driver
        ? [
            {
              instanceId: ProviderInstanceId.make(id),
              driver: instance.driver,
              email: limits.get(ProviderInstanceId.make(id))?.auth?.email,
              usageLimits: limits.get(ProviderInstanceId.make(id))?.usageLimits,
            },
          ]
        : [],
    ),
    usage.now,
    preferred,
    usage.load,
  );
};

/**
 * The account a cloud box moves its driver onto once the one it runs on is spent: the best ranked
 * account of the driver whose login can leave this machine, skipping the excluded accounts, any
 * account of the same subscription as one of them (by email), and any known to be spent. A usage
 * reading can be half an hour old, so the account that just hit its limit is excluded by the
 * caller rather than trusted to read as spent. None when no account qualifies.
 */
export const resolveSwitchProfile = Effect.fn("resolveSwitchProfile")(function* (
  settings: ServerSettings,
  input: { readonly driver: string; readonly exclude: ReadonlySet<string> },
  claudeOAuthTokens: Provisioning["claudeOAuthTokens"] | undefined,
  usage: AccountUsage,
  hostLogins?: HostLogins,
) {
  const accounts = rankDriverAccounts(settings, input.driver, usage);
  const excludedEmails = new Set(
    accounts.flatMap(({ instanceId, email }) =>
      input.exclude.has(instanceId) && email ? [email.toLowerCase()] : [],
    ),
  );
  for (const account of accounts) {
    if (
      input.exclude.has(account.instanceId) ||
      (account.email !== undefined && excludedEmails.has(account.email.toLowerCase())) ||
      isAccountSpent(account.driver, account.usageLimits, usage.now)
    )
      continue;
    const profile = yield* Effect.result(
      resolveProvisioningProviderProfile(
        settings,
        { providerInstanceId: account.instanceId, agentDriver: input.driver },
        claudeOAuthTokens,
        hostLogins,
      ),
    );
    if (profile._tag === "Success") return Option.some(profile.success);
  }
  return Option.none<ProvisioningProviderProfile>();
});

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
  usage: AccountUsage,
  hostLogins?: HostLogins,
) {
  const instances = deriveProviderInstanceConfigMap(settings);
  const hint = ProviderInstanceId.make(input.providerInstanceId);
  const limits = new Map(usage.providers.map((provider) => [provider.instanceId, provider]));
  const ranked = (driver: string) =>
    rankDriverAccounts(settings, driver, usage, hint).map(({ instanceId }) => instanceId);
  const firstPortable = Effect.fnUntraced(function* (driver: string) {
    const refusals = [];
    for (const instanceId of ranked(driver)) {
      const profile = yield* Effect.result(
        resolveProvisioningProviderProfile(
          settings,
          { providerInstanceId: instanceId, agentDriver: driver },
          claudeOAuthTokens,
          hostLogins,
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
  // A pinned account is never swapped for another, so one known to be spent refuses here
  // rather than starting a machine whose first turn fails.
  if (
    input.pinAccount &&
    driver !== undefined &&
    isAccountSpent(ProviderDriverKind.make(driver), limits.get(hint)?.usageLimits, usage.now)
  )
    return yield* new ProvisionRefused({
      reason: "credentials",
      message: `${instances[hint]?.displayName ?? hint} is over its usage limit.`,
    });
  const routed =
    driver === undefined || input.pinAccount ? Option.none() : yield* firstPortable(driver);
  const primary = Option.isSome(routed)
    ? routed.value
    : yield* resolveProvisioningProviderProfile(
        settings,
        { providerInstanceId: input.providerInstanceId, agentDriver: input.agentDriver },
        claudeOAuthTokens,
        hostLogins,
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
