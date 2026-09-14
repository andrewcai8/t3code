import type { NamespaceArtifact } from "./config.ts";

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
  readonly create: (input: {
    readonly size: string;
    readonly region?: string | undefined;
    readonly idleTimeoutMinutes?: number | undefined;
    readonly repository?: string | undefined;
    readonly branch?: string | undefined;
  }) => Promise<NamespaceResource>;
  readonly resume: (input: {
    readonly resource: NamespaceResource;
    readonly port: number;
    readonly environmentId: string;
  }) => Promise<{ readonly resource: NamespaceResource; readonly upstreamOrigin: string }>;
  readonly bootstrap: (input: {
    readonly resource: NamespaceResource;
    readonly projectDir: string;
    readonly providerInstanceId: string;
    readonly agentDriver?: string | undefined;
    readonly repository?: string | undefined;
    readonly branch?: string | undefined;
    readonly githubToken?: string | undefined;
    readonly files?: readonly {
      readonly source: string;
      readonly destination: string;
      readonly mode?: string | undefined;
    }[];
    readonly environment?: readonly {
      readonly name: string;
      readonly value: string;
      readonly sensitive?: boolean;
    }[];
    readonly prepareCommands?: readonly string[];
    readonly verifyCommands?: readonly string[];
    readonly artifacts?: readonly NamespaceArtifact[] | undefined;
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
  readonly agentDriver?: string | undefined;
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
  readonly githubToken?: string | undefined;
  readonly files?: readonly {
    readonly source: string;
    readonly destination: string;
    readonly mode?: string | undefined;
  }[];
  readonly environment?: readonly {
    readonly name: string;
    readonly value: string;
    readonly sensitive?: boolean;
  }[];
  readonly prepareCommands?: readonly string[];
  readonly verifyCommands?: readonly string[];
  readonly artifacts?: readonly NamespaceArtifact[] | undefined;
  readonly workspaceFiles?: readonly {
    readonly source: string;
    readonly destination: string;
  }[];
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
    await runner.bootstrap({
      ...request,
      resource,
      projectDir,
      files: [
        ...(request.files ?? []),
        ...(request.workspaceFiles ?? []).map((file) => ({
          ...file,
          destination: `${projectDir}/${file.destination}`,
          mode: "600",
        })),
      ],
    });
    const pairingUrl = await runner.expose({ resource, port: namespaceT3Port(resource) });
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
