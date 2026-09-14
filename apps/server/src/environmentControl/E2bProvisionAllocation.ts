import type { E2bProvisionResource, ProvisionOperation } from "@t3tools/contracts";
import { E2B, Sandbox, type E2BClientOpts, type SandboxInfo, type SandboxNetworkOpts } from "e2b";
import * as Effect from "effect/Effect";
import { ProvisionProviderError, type ProvisionProviderPorts } from "./Provisioning.ts";

import {
  ProvisionRetentionError,
  retentionTimeoutMs,
  verifyRetentionDeadline,
} from "./retention.ts";

type E2bAllocationPorts = Pick<
  ProvisionProviderPorts["Service"],
  "create" | "recoverCreate" | "fork" | "recoverFork"
>;
export interface E2bAllocationConfig {
  readonly connection: E2BClientOpts;
  readonly parentTimeoutMs: number;
  readonly sandboxTimeoutMs: number;
  readonly network?: SandboxNetworkOpts;
  readonly maxRecoveryPages?: number;
}

const e2bRequest = Effect.fn("E2bProvisionAllocation.request")(function* (
  operation: ProvisionOperation,
) {
  if (operation.request.provider !== "e2b")
    return yield* new ProvisionProviderError({
      message: "E2B cannot allocate another provider's request",
    });
  return operation.request;
});
function metadata(operation: ProvisionOperation, templateId: string) {
  return {
    purpose: "t3-environment",
    account: operation.request.providerInstanceId,
    provision_request_id: operation.request.requestId,
    provision_request_hash: operation.requestHash,
    provision_template_id: templateId,
    preparation_hash: operation.request.preparationHash,
  };
}
function owned(info: SandboxInfo, operation: ProvisionOperation, templateId: string) {
  return (
    info.templateId === templateId &&
    Object.entries(metadata(operation, templateId)).every(
      ([key, value]) => info.metadata[key] === value,
    )
  );
}

export function makeE2bAllocationPorts(config: E2bAllocationConfig): E2bAllocationPorts {
  const client = new E2B(config.connection);
  const list = Effect.fn("E2bProvisionAllocation.list")(function* (operation: ProvisionOperation) {
    const request = yield* e2bRequest(operation);
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const paginator = client.Sandbox.list({
          query: {
            metadata: metadata(operation, request.templateId),
            state: ["running", "paused"],
            template: request.templateId,
          },
          limit: 100,
        });
        const resources = new Map<string, E2bProvisionResource>();
        for (let page = 0; paginator.hasNext; page += 1) {
          if (page >= (config.maxRecoveryPages ?? 100))
            throw new Error("Recovery pagination incomplete");
          for (const info of await paginator.nextItems({ signal })) {
            if (owned(info, operation, request.templateId))
              resources.set(info.sandboxId, { provider: "e2b", sandboxId: info.sandboxId });
          }
        }
        return [...resources.values()];
      },
      catch: () =>
        new ProvisionProviderError({
          message: "E2B resource discovery was incomplete; allocation remains unresolved",
        }),
    });
  });
  return {
    create: Effect.fn("E2bProvisionAllocation.create")(function* (operation) {
      const request = yield* e2bRequest(operation);
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const sandbox = await client.Sandbox.create(request.templateId, {
            signal,
            metadata: metadata(operation, request.templateId),
            timeoutMs: retentionTimeoutMs(
              request.retentionDeadline,
              request.strategy === "fork" ? config.parentTimeoutMs : config.sandboxTimeoutMs,
            ),
            lifecycle: { onTimeout: "kill" },
            ...(config.network ? { network: config.network } : {}),
          });
          await verifyRetentionDeadline(request.retentionDeadline, {
            read: async () => (await client.Sandbox.getInfo(sandbox.sandboxId, { signal })).endAt,
            shorten: (timeoutMs) =>
              client.Sandbox.setTimeout(sandbox.sandboxId, timeoutMs, { signal }),
          });
          return { provider: "e2b", sandboxId: sandbox.sandboxId } satisfies E2bProvisionResource;
        },
        catch: (error) =>
          new ProvisionProviderError({
            ...(error instanceof ProvisionRetentionError ? { retentionFailed: true } : {}),
            message:
              "E2B create response is uncertain; recover the existing allocation before proceeding",
          }),
      });
    }),
    recoverCreate: list,
    fork: Effect.fn("E2bProvisionAllocation.fork")(function* (operation, parent) {
      const request = yield* e2bRequest(operation);
      if (request.strategy !== "fork")
        return yield* new ProvisionProviderError({ message: "Direct E2B allocation cannot fork" });
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const info = await client.Sandbox.getInfo(parent.sandboxId, { signal });
          if (info.sandboxId !== parent.sandboxId || !owned(info, operation, request.templateId))
            throw new Error("Parent ownership changed");
          await verifyRetentionDeadline(request.retentionDeadline, {
            read: async () => (await client.Sandbox.getInfo(parent.sandboxId, { signal })).endAt,
            shorten: (timeoutMs) =>
              client.Sandbox.setTimeout(parent.sandboxId, timeoutMs, { signal }),
          });
          const forks = await client.Sandbox.fork(parent.sandboxId, {
            signal,
            count: 1,
            timeoutMs: retentionTimeoutMs(request.retentionDeadline, config.sandboxTimeoutMs),
          });
          const child = forks.length === 1 ? forks[0] : undefined;
          if (!(child instanceof Sandbox) || child.sandboxId === parent.sandboxId)
            throw new Error("Fork response did not identify one child");
          await verifyRetentionDeadline(request.retentionDeadline, {
            read: async () => (await client.Sandbox.getInfo(child.sandboxId, { signal })).endAt,
            shorten: (timeoutMs) =>
              client.Sandbox.setTimeout(child.sandboxId, timeoutMs, { signal }),
          });
          return { provider: "e2b", sandboxId: child.sandboxId } satisfies E2bProvisionResource;
        },
        catch: (error) =>
          new ProvisionProviderError({
            ...(error instanceof ProvisionRetentionError ? { retentionFailed: true } : {}),
            message: "E2B fork response is uncertain; recover the existing child before proceeding",
          }),
      });
    }),
    recoverFork: (operation) => list(operation),
  };
}
