export interface NamespaceResource {
  readonly provider: "namespace";
  readonly devboxId: string;
  readonly devboxName?: string | undefined;
  readonly instanceId: string;
  readonly t3Port?: number | undefined;
  readonly region: string;
  readonly workspaceDir: string;
  /** Missing only on legacy leases whose home was not retained. */
  readonly homeDir?: string | undefined;
}

export const namespaceT3Port = (resource: NamespaceResource): number => resource.t3Port ?? 3000;

export interface NamespaceRunner {
  readonly resume: (input: {
    readonly resource: NamespaceResource;
    readonly port: number;
    readonly environmentId: string;
  }) => Promise<{ readonly resource: NamespaceResource; readonly upstreamOrigin: string }>;
  readonly destroyInstance: (resource: NamespaceResource) => Promise<void | "missing">;
  readonly expireDevbox: (resource: NamespaceResource) => Promise<void>;
}

function isNotFound(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /(?:status\s*[:=]?\s*)?404\b|not[\s_-]?found/i.test(message);
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
