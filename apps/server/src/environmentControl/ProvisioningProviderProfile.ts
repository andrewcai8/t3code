// @effect-diagnostics nodeBuiltinImport:off - portable credentials are resolved at the provisioning boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { cursorFileCredentialPath } from "../provider/cursorCredentialPath.ts";
import type { Provisioning } from "./config.ts";

export class ProvisionRefused extends Schema.TaggedError<ProvisionRefused>()("ProvisionRefused", {
  reason: Schema.Literals(["unconfigured", "credentials", "unsupported"]),
  message: Schema.String,
}) {}

export interface ProvisioningProviderProfile {
  readonly kind: "codex" | "cursor" | "claudeAgent";
  readonly instanceId: ProviderInstanceId;
  readonly environment: ProviderInstanceEnvironment;
  readonly credential:
    | { readonly kind: "file"; readonly source: string; readonly destination: string }
    | { readonly kind: "environment" };
}

const credentialVariables = {
  codex: ["OPENAI_API_KEY"],
  cursor: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
  claudeAgent: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
};
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const decodeCursorSettings = Schema.decodeUnknownEffect(CursorSettings);

export const resolveProvisioningProviderProfile = Effect.fn("resolveProvisioningProviderProfile")(
  function* (
    settings: ServerSettings,
    input: { readonly providerInstanceId: string; readonly agentDriver?: string | undefined },
  ) {
    const instanceId = ProviderInstanceId.make(input.providerInstanceId);
    const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
    if (!instance || (input.agentDriver !== undefined && instance.driver !== input.agentDriver))
      return yield* new ProvisionRefused({
        reason: "credentials",
        message: "The selected provider account is unavailable on this machine.",
      });
    const environment = instance.environment ?? [];
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
        environment,
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
            ? "This Claude account needs portable credentials for cloud use. Local keychain credentials cannot be copied."
            : "The selected account credentials could not be found on this machine.",
      });
    return {
      kind,
      instanceId,
      environment,
      credential: { kind: "file", source, destination },
    } satisfies ProvisioningProviderProfile;
  },
);

export async function buildNamespacePreparation(
  profile: ProvisioningProviderProfile,
  provisioning: Provisioning,
) {
  const files = new Map<string, { source: string; destination: string; mode: string }>();
  for (const file of [
    ...(provisioning.homeFiles ?? []),
    ...(profile.credential.kind === "file" ? [profile.credential] : []),
  ]) {
    const destination = NodePath.posix.normalize(
      file.destination.replace(/^\/Users\/runner\//, ""),
    );
    if (
      NodePath.posix.isAbsolute(destination) ||
      destination === ".." ||
      destination.startsWith("../") ||
      destination === "."
    )
      throw new ProvisionRefused({
        reason: "unconfigured",
        message: "A configured home file escapes the workspace home.",
      });
    files.set(destination, { source: file.source, destination, mode: "600" });
  }
  const paths = {
    HOME: "/Users/runner",
    PATH: "/Users/runner/.local/bin:/Users/runner/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    ...(profile.kind === "codex" ? { CODEX_HOME: "/Users/runner/.codex" } : {}),
    ...(profile.kind === "claudeAgent" ? { CLAUDE_CONFIG_DIR: "/Users/runner/.claude" } : {}),
    ...(profile.kind === "cursor"
      ? { AGENT_CLI_CREDENTIAL_STORE: "file", CURSOR_CONFIG_DIR: "/Users/runner/.cursor" }
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
    if (selectedNames.has(variable.name)) continue;
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
  for (const variable of profile.environment) environment.set(variable.name, variable);

  for (const [name, value] of Object.entries(paths))
    environment.set(name, { name, value, sensitive: false });
  return {
    files: [...files.values()],
    environment: [...environment.values()],
    prepareCommands: provisioning.namespace?.prepareCommands ?? [],
  };
}
