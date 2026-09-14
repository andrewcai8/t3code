import { createClient, createGlobalTransport } from "@namespacelabs/sdk/api";
import { extractClaims, fromBearerToken, loadUserToken } from "@namespacelabs/sdk/auth";
import {
  AccessMode,
  DevBoxService,
  type DevBox,
} from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import { StringMatcher_Operator } from "@namespacelabs/sdk/proto/namespace/stdlib/matchers_pb";
import {
  type DurableProvisionRequest,
  type ProvisionOperation,
  ProvisionResource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProvisionProviderError, type ProvisionProviderPorts } from "./Provisioning.ts";

export const namespaceMacImage = "tahoe-xcode-26.4.x-latest";
const namespaceMacImageSelectors = [
  { name: "macos.version", value: "26.x" },
  { name: "macos.purpose", value: "githubrunner" },
  { name: "image.with", value: "xcode-26.4.x" },
  { name: "image.with", value: "xcode-beta" },
];

const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    actor_id: Schema.String.check(Schema.isMinLength(1)),
    tenant_id: Schema.String.check(Schema.isMinLength(1)),
  }),
);
const decodeResource = Schema.decodeUnknownSync(ProvisionResource);

export async function resolveNamespaceIdentity(token?: string) {
  const source = token ? fromBearerToken(token) : await loadUserToken();
  const claims = decodeIdentity(extractClaims(await source.issueToken(1_000)));
  return { creator: claims.actor_id, tenantId: claims.tenant_id };
}

export async function createNamespaceAllocationClient(
  options: { readonly token?: string; readonly baseUrl?: string } = {},
) {
  const tokenSource = options.token ? fromBearerToken(options.token) : await loadUserToken();
  return createClient(
    DevBoxService,
    createGlobalTransport({
      tokenSource,
      baseUrl: options.baseUrl ?? "https://private-api.global.namespaceapis.com",
    }),
  );
}

type NamespaceRequest = Extract<DurableProvisionRequest, { provider: "namespace" }>;
type NamespaceAllocationPorts = Pick<ProvisionProviderPorts["Service"], "create" | "recoverCreate">;
export interface NamespaceAllocationConfig {
  readonly identity: Awaited<ReturnType<typeof resolveNamespaceIdentity>>;
  readonly client: Pick<
    Awaited<ReturnType<typeof createNamespaceAllocationClient>>,
    "list" | "fetch"
  >;
  /** Execute with the same frozen Namespace account as the SDK client. */
  readonly execute: (args: ReadonlyArray<string>, signal: AbortSignal) => Promise<void>;
  readonly maxRecoveryPages?: number;
}

const namespaceRequest = Effect.fn("namespaceAllocation.request")(function* (
  operation: ProvisionOperation,
  identity: NamespaceAllocationConfig["identity"],
) {
  if (operation.request.provider !== "namespace")
    return yield* new ProvisionProviderError({
      message: "Namespace cannot allocate another provider's request",
    });
  if (operation.request.image !== namespaceMacImage || !["m", "l"].includes(operation.request.size))
    return yield* new ProvisionProviderError({
      message: "Namespace Mac image or size is not qualified for durable allocation",
    });
  if (
    operation.request.creator !== identity.creator ||
    operation.request.tenantId !== identity.tenantId
  )
    return yield* new ProvisionProviderError({
      message: "Namespace account does not match the persisted request",
    });
  return operation.request;
});

const selectorIdentity = (
  selectors: ReadonlyArray<{ readonly name: string; readonly value: string }>,
) =>
  JSON.stringify(
    selectors
      .map(({ name, value }) => [name, value])
      .sort(([a, av], [b, bv]) => `${a}\0${av}`.localeCompare(`${b}\0${bv}`)),
  );
const imageIdentity = selectorIdentity(namespaceMacImageSelectors);

export function namespaceResourceMatches(box: DevBox, request: NamespaceRequest) {
  return (
    box.name === `t3-${request.requestId}` &&
    box.creator === request.creator &&
    box.site === request.region &&
    box.repository === "" &&
    box.imageRef === "" &&
    box.accessMode === AccessMode.USER_PRIVATE &&
    box.instanceShape?.os === "macos" &&
    box.instanceShape.machineArch === "arm64" &&
    box.instanceShape.virtualCpu === (request.size === "l" ? 12 : 6) &&
    box.instanceShape.memoryMegabytes === (request.size === "l" ? 28672 : 14336) &&
    selectorIdentity(box.instanceShape.selectors) === imageIdentity
  );
}

/** Creation uses the Mac CLI image resolver. Recovery reads every SDK page before adopting anything. */
export function makeNamespaceAllocationPorts(
  config: NamespaceAllocationConfig,
): NamespaceAllocationPorts {
  const discover = async (request: NamespaceRequest, signal: AbortSignal) => {
    const candidates = new Map<string, DevBox>();
    let cursor: Uint8Array = new Uint8Array();
    const cursors = new Set<string>();
    for (let page = 0; ; page += 1) {
      if (page >= (config.maxRecoveryPages ?? 100))
        throw new Error("Namespace recovery pagination incomplete");
      const response = await config.client.list(
        {
          paginationCursor: cursor,
          matchCreator: { values: [request.creator], op: StringMatcher_Operator.IS_ANY_OF },
        },
        { signal, timeoutMs: 30_000 },
      );
      for (const box of response.devboxes)
        if (namespaceResourceMatches(box, request)) candidates.set(box.id, box);
      cursor = response.paginationCursor;
      if (cursor.length === 0) break;
      const identity = Array.from(cursor).join(",");
      if (cursors.has(identity)) throw new Error("Namespace repeated a recovery cursor");
      cursors.add(identity);
    }
    const resources = [];
    for (const candidate of candidates.values()) {
      const response = await config.client.fetch(
        { id: candidate.id, returnActivatedInstance: true },
        { signal, timeoutMs: 30_000 },
      );
      if (
        !response.devbox ||
        response.devbox.id !== candidate.id ||
        !namespaceResourceMatches(response.devbox, request)
      )
        throw new Error("Namespace resource changed during discovery");
      if (!response.instanceId)
        throw new Error("Namespace resource is not activated; allocation remains unresolved");
      resources.push(
        decodeResource({
          provider: "namespace",
          devboxId: response.devbox.id,
          devboxName: response.devbox.name,
          instanceId: response.instanceId,
          region: response.devbox.site,
          workspaceDir: response.devbox.workspaceDir,
        }),
      );
    }
    return resources;
  };

  return {
    create: Effect.fn("namespaceAllocation.create")(function* (operation) {
      const request = yield* namespaceRequest(operation, config.identity);
      return yield* Effect.tryPromise({
        try: async (signal) => {
          await config.execute(
            [
              "create",
              "--name",
              `t3-${request.requestId}`,
              "--ephemeral",
              "--activate",
              "--platform",
              "macos/arm64",
              "--size",
              request.size,
              "--image",
              request.image,
              "--site",
              request.region,
              "--auto_stop_idle_timeout",
              `${request.idleTimeoutMinutes}m`,
              "--no_checkout",
              "--access_mode",
              "private",
            ],
            signal,
          );
          const resources = await discover(request, signal);
          const resource = resources.length === 1 ? resources[0] : undefined;
          if (!resource) throw new Error("Namespace create has no unique matching resource");
          return resource;
        },
        catch: () =>
          new ProvisionProviderError({
            message:
              "Namespace create response is uncertain; recover the existing allocation before proceeding",
          }),
      });
    }),
    recoverCreate: Effect.fn("namespaceAllocation.recoverCreate")(function* (operation) {
      const request = yield* namespaceRequest(operation, config.identity);
      return yield* Effect.tryPromise({
        try: (signal) => discover(request, signal),
        catch: () =>
          new ProvisionProviderError({
            message: "Namespace discovery was incomplete; allocation remains unresolved",
          }),
      });
    }),
  };
}
