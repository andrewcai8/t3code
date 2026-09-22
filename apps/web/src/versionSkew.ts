import type {
  EnvironmentId,
  EnvironmentProvisionUpgradeResult,
  ServerConfig,
  ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import type { ProvisionedSandboxLease } from "@t3tools/client-runtime/cloud";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

import { APP_VERSION } from "./branding";
import { provisionedSandboxForEnvironment } from "./cloud/provisionedSandboxLeases";
import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export interface VersionMismatch {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly hint: string;
}

const VERSION_MISMATCH_DISMISSALS_STORAGE_KEY = "t3code:version-mismatch-dismissals:v1";

// Runtime failures retain their identity until the next attempt. Dismiss only
// that attempt, across chat remounts, without clearing the error in Settings.
const dismissedServerUpdateFailures = new WeakSet<ServerUpdateState>();

export function isServerUpdateFailureDismissed(state: ServerUpdateState): boolean {
  return state.status === "failed" && dismissedServerUpdateFailures.has(state);
}

export function dismissServerUpdateFailure(state: ServerUpdateState): void {
  if (state.status === "failed") dismissedServerUpdateFailures.add(state);
}

const VersionMismatchDismissalsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
});

type VersionMismatchDismissals = typeof VersionMismatchDismissalsSchema.Type;

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/** Core `major.minor.patch`, dropping any prerelease or build suffix. */
function versionCore(version: string): string {
  return version.replace(/[-+].*$/, "");
}

/**
 * The skew a user can act on: the connected server runs an older T3 Code than
 * this client, so the server is the side that needs updating.
 *
 * Two nightly builds compare their full versions, including the date and run.
 * Other combinations compare their core `major.minor.patch` only, so a stable
 * build and a nightly build with the same core do not cause an update warning.
 * A server ahead of the client does not need an update. Versions that do not
 * parse as semver fall back to plain string inequality.
 */
export function resolveVersionMismatch(
  serverVersion: string | null | undefined,
): VersionMismatch | null {
  const normalizedClientVersion = normalizeVersion(APP_VERSION);
  const normalizedServerVersion = normalizeVersion(serverVersion);
  if (!normalizedClientVersion || !normalizedServerVersion) {
    return null;
  }

  const clientCore = versionCore(normalizedClientVersion);
  const serverCore = versionCore(normalizedServerVersion);
  const compareNightlyBuilds =
    parseSemver(normalizedClientVersion)?.prerelease[0] === "nightly" &&
    parseSemver(normalizedServerVersion)?.prerelease[0] === "nightly";
  const serverIsBehind =
    parseSemver(clientCore) && parseSemver(serverCore)
      ? compareSemverVersions(
          compareNightlyBuilds ? normalizedServerVersion : serverCore,
          compareNightlyBuilds ? normalizedClientVersion : clientCore,
        ) < 0
      : normalizedServerVersion !== normalizedClientVersion;
  if (!serverIsBehind) {
    return null;
  }

  return {
    clientVersion: normalizedClientVersion,
    serverVersion: normalizedServerVersion,
    hint: "Version mismatch. Try syncing the client and server to the same T3 Code version.",
  };
}

export function resolveServerConfigVersionMismatch(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): VersionMismatch | null {
  return resolveVersionMismatch(serverConfig?.environment.serverVersion);
}

/** The update path the connected server offers, or null when it only
    supports a manual relaunch (older servers, dev checkouts, Windows). */
export function resolveServerSelfUpdateCapability(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): ServerSelfUpdateCapability | null {
  return serverConfig?.environment.capabilities.serverSelfUpdate ?? null;
}

/** True when the desktop app supervising this server can be told to update
    itself over RPC. Older desktop servers only get the manual instruction. */
export function supportsDesktopAppUpdate(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.desktopAppUpdate === true;
}

/** True when the connected server can recover opted-in running turns after
    its self-update restart. */
export function supportsServerUpdateThreadContinuation(
  serverConfig: Pick<ServerConfig, "environment"> | null | undefined,
): boolean {
  return serverConfig?.environment.capabilities.serverUpdateThreadContinuation === true;
}

/** The command to hand users whose server cannot update itself. */
export function manualServerUpdateCommand(targetVersion: string): string {
  return `npx t3@${targetVersion}`;
}

/**
 * How a version-skewed server gets onto the client's version. A server that
 * advertises a self-update path keeps it. A provisioned guest without one is
 * upgraded by the manager that owns its lease, since the public `npx t3`
 * package is the wrong build for a fork guest. Anything else gets the command.
 */
export type ServerUpdatePath =
  | { readonly kind: "self-update"; readonly capability: ServerSelfUpdateCapability }
  | { readonly kind: "manager-upgrade"; readonly lease: ProvisionedSandboxLease }
  | { readonly kind: "manual-command" };

export function resolveServerUpdatePath({
  selfUpdate,
  lease,
}: {
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly lease: ProvisionedSandboxLease | null;
}): ServerUpdatePath {
  if (selfUpdate !== null) return { kind: "self-update", capability: selfUpdate };
  if (lease !== null) return { kind: "manager-upgrade", lease };
  return { kind: "manual-command" };
}

/** The update path for a connected environment, using the lease this client holds for it. */
export function resolveEnvironmentServerUpdatePath(
  environmentId: EnvironmentId | null,
  selfUpdate: ServerSelfUpdateCapability | null,
): ServerUpdatePath {
  return resolveServerUpdatePath({
    selfUpdate,
    lease:
      environmentId === null
        ? null
        : (provisionedSandboxForEnvironment(environmentId)?.lease ?? null),
  });
}

export function serverUpdateGuidance(path: ServerUpdatePath): string | null {
  switch (path.kind) {
    case "self-update":
      return path.capability === "desktop-managed"
        ? "Update the desktop app"
        : "Update to stay in sync";
    case "manager-upgrade":
      return "Installs the manager's current build on this server.";
    case "manual-command":
      return null;
  }
}

export interface UpgradeResultToast {
  readonly type: "success" | "info" | "error";
  readonly title: string;
  readonly description?: string;
}

export function describeUpgradeResult(
  result: EnvironmentProvisionUpgradeResult,
  serverLabel: string,
): UpgradeResultToast {
  switch (result.kind) {
    case "upgraded":
      return {
        type: "success",
        title: `${serverLabel} updated`,
        description: `Now on ${result.t3Revision.slice(0, 7)}`,
      };
    case "current":
      return { type: "info", title: `${serverLabel} is already on the manager's build` };
    case "refused":
      return {
        type: "error",
        title: `${serverLabel} update refused`,
        description: result.message,
      };
  }
}

export function buildVersionMismatchDismissalKey(
  environmentId: EnvironmentId,
  mismatch: Pick<VersionMismatch, "clientVersion" | "serverVersion">,
): string {
  return `${environmentId}:${mismatch.clientVersion}:${mismatch.serverVersion}`;
}

function readVersionMismatchDismissals(): VersionMismatchDismissals {
  try {
    return (
      getLocalStorageItem(
        VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
        VersionMismatchDismissalsSchema,
      ) ?? { keys: [] }
    );
  } catch (error) {
    console.error("Could not read version-mismatch dismissals.", error);
    return { keys: [] };
  }
}

function writeVersionMismatchDismissals(document: VersionMismatchDismissals): void {
  try {
    setLocalStorageItem(
      VERSION_MISMATCH_DISMISSALS_STORAGE_KEY,
      document,
      VersionMismatchDismissalsSchema,
    );
  } catch (error) {
    console.error("Could not persist version-mismatch dismissals.", error);
  }
}

export function isVersionMismatchDismissed(dismissalKey: string | null | undefined): boolean {
  if (!dismissalKey) {
    return false;
  }
  return readVersionMismatchDismissals().keys.includes(dismissalKey);
}

export function dismissVersionMismatch(dismissalKey: string | null | undefined): void {
  if (!dismissalKey) {
    return;
  }
  const document = readVersionMismatchDismissals();
  if (document.keys.includes(dismissalKey)) {
    return;
  }
  writeVersionMismatchDismissals({
    keys: [...document.keys, dismissalKey],
  });
}
