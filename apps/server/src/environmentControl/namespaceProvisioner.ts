/** The provider boundary for an ephemeral Namespace Mac. */
export interface NamespaceResource {
  readonly provider: "namespace";
  readonly devboxId: string;
  readonly devboxName?: string | undefined;
  readonly instanceId: string;
  readonly region: string;
  /** The image's real workspace root; macOS Devboxes use /Users/runner. */
  readonly workspaceDir: string;
}

export interface NamespaceRunner {
  readonly create: (input: {
    readonly size: string;
    readonly region?: string | undefined;
    readonly idleTimeoutMinutes?: number | undefined;
    readonly repository?: string | undefined;
    readonly branch?: string | undefined;
  }) => Promise<NamespaceResource>;
  readonly bootstrap: (input: {
    readonly resource: NamespaceResource;
    readonly projectDir: string;
    readonly providerInstanceId: string;
    readonly repository?: string | undefined;
    readonly branch?: string | undefined;
  }) => Promise<void>;
  readonly expose: (input: {
    readonly resource: NamespaceResource;
    readonly port: number;
  }) => Promise<string>;
  readonly destroyInstance: (resource: NamespaceResource) => Promise<void>;
  readonly expireDevbox: (resource: NamespaceResource) => Promise<void>;
}

export interface NamespaceProvisionRequest {
  readonly size: string;
  readonly region?: string | undefined;
  readonly idleTimeoutMinutes?: number | undefined;
  readonly providerInstanceId: string;
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
}

export interface NamespaceProvisioned {
  readonly resource: NamespaceResource;
  readonly pairingUrl: string;
  readonly projectDir: string;
}

function isNotFound(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:status\s*[:=]?\s*)?404\b|not[\s_-]?found/i.test(message);
}

/** Create and prepare a Namespace Mac, leaving it reachable through T3. */
export async function provisionNamespace(
  runner: NamespaceRunner,
  request: NamespaceProvisionRequest,
): Promise<NamespaceProvisioned> {
  const resource = await runner.create(request);
  const projectDir = resource.workspaceDir;
  try {
    await runner.bootstrap({ ...request, resource, projectDir });
    const pairingUrl = await runner.expose({ resource, port: 3000 });
    return { resource, pairingUrl, projectDir };
  } catch (cause) {
    await disposeNamespace(runner, resource).catch(() => undefined);
    throw cause;
  }
}

/** Dispose both the running instance and the Devbox record, safely retryable. */
export async function disposeNamespace(
  runner: NamespaceRunner,
  resource: NamespaceResource,
): Promise<void> {
  try {
    await runner.destroyInstance(resource);
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
  try {
    await runner.expireDevbox(resource);
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
}
