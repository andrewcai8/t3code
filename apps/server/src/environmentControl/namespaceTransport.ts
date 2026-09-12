import type { NamespaceResource } from "./namespaceProvisioner.ts";

export interface RelayEndpoint {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly providerKind: "t3_relay";
}

export interface NamespaceMac {
  readonly create: (input: {
    readonly size: string;
    readonly region?: string | undefined;
    readonly idleTimeoutMinutes?: number | undefined;
  }) => Promise<NamespaceResource>;
  readonly bootstrap: (input: {
    readonly resource: NamespaceResource;
    readonly projectDir: string;
    readonly providerInstanceId: string;
    readonly connectorToken: string;
    readonly repository?: string | undefined;
    readonly branch?: string | undefined;
  }) => Promise<{ readonly pairingToken: string }>;
  readonly destroyInstance: (resource: NamespaceResource) => Promise<void>;
  readonly expireDevbox: (resource: NamespaceResource) => Promise<void>;
}

export interface RelayControlPlane {
  readonly provision: (input: {
    readonly environmentId: string;
    readonly label: string;
    readonly origin: string;
  }) => Promise<{ readonly endpoint: RelayEndpoint; readonly connectorToken: string }>;
  readonly release: (input: { readonly environmentId: string }) => Promise<void>;
}

export interface SecretStore {
  readonly put: (token: string) => Promise<string>;
  readonly delete: (tokenId: string) => Promise<void>;
}

export interface NamespaceTransportRequest {
  readonly environmentId: string;
  readonly label: string;
  readonly origin: string;
  readonly size: string;
  readonly region?: string | undefined;
  readonly idleTimeoutMinutes?: number | undefined;
  readonly providerInstanceId: string;
  readonly repository?: string | undefined;
  readonly branch?: string | undefined;
}

export interface NamespaceTransportLease {
  readonly resource: NamespaceResource;
  readonly endpoint: RelayEndpoint;
  readonly pairingUrl: string;
  readonly environmentId: string;
  readonly connectorTokenId: string;
  readonly projectDir: string;
}

/** Provision Namespace and its relay as one compensating transaction. */
export async function provisionNamespaceTransport(
  mac: NamespaceMac,
  relay: RelayControlPlane,
  secrets: SecretStore,
  request: NamespaceTransportRequest,
): Promise<NamespaceTransportLease> {
  const resource = await mac.create(request);
  let tokenId: string | undefined;
  try {
    const allocated = await relay.provision({
      environmentId: request.environmentId,
      label: request.label,
      origin: request.origin,
    });
    tokenId = await secrets.put(allocated.connectorToken);
    const projectDir = resource.workspaceDir;
    const bootstrapped = await mac.bootstrap({
      resource,
      projectDir,
      providerInstanceId: request.providerInstanceId,
      connectorToken: allocated.connectorToken,
      repository: request.repository,
      branch: request.branch,
    });
    const pairingUrl = new URL(allocated.endpoint.httpBaseUrl);
    pairingUrl.pathname = "/pair";
    pairingUrl.search = "";
    pairingUrl.hash = `token=${encodeURIComponent(bootstrapped.pairingToken)}`;
    return {
      resource,
      endpoint: allocated.endpoint,
      pairingUrl: pairingUrl.toString(),
      environmentId: request.environmentId,
      connectorTokenId: tokenId,
      projectDir,
    };
  } catch (cause) {
    await disposeNamespaceTransport(mac, relay, secrets, {
      resource,
      environmentId: request.environmentId,
      connectorTokenId: tokenId,
    }).catch(() => undefined);
    throw cause;
  }
}

export async function disposeNamespaceTransport(
  mac: NamespaceMac,
  relay: RelayControlPlane,
  secrets: SecretStore,
  lease: {
    readonly resource: NamespaceResource;
    readonly environmentId: string;
    readonly connectorTokenId?: string | undefined;
  },
): Promise<void> {
  let firstError: unknown;
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (cause) {
      firstError ??= cause;
    }
  };
  if (lease.connectorTokenId !== undefined) {
    const tokenId = lease.connectorTokenId;
    await attempt(() => secrets.delete(tokenId));
  }
  await attempt(() => relay.release({ environmentId: lease.environmentId }));
  await attempt(() => mac.destroyInstance(lease.resource));
  await attempt(() => mac.expireDevbox(lease.resource));
  if (firstError !== undefined) throw firstError;
}
