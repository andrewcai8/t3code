import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, EnvironmentProvisionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProvisionControl } from "./ProvisionControl.ts";
import { ProvisionPreparationManifest } from "./ProvisionPreparation.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";
import { Provisioning, ProvisionProviderPorts } from "./Provisioning.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
const input = Schema.decodeUnknownSync(EnvironmentProvisionInput)({
  requestId: "56d8ba31-df41-4918-be6a-acab453c8aed",
  provider: "e2b",
  providerInstanceId: "codex",
});
const manifest = Schema.decodeUnknownSync(ProvisionPreparationManifest)({
  input,
  request: {
    ...input,
    sourceRevision: null,
    templateId: "template",
    strategy: "direct",
    preparationHash: "a".repeat(64),
  },
  preparation: {
    requestId: input.requestId,
    root: "/private/operation",
    repository: null,
    artifact: {
      archivePath: "/private/archive",
      sha256: "b".repeat(64),
      revision: "c".repeat(40),
      entrypoint: "dist/bin.mjs",
    },
    runtimeExecutable: "node",
    port: 3773,
    readinessTimeoutSeconds: 180,
    brokerTtl: "7d",
    files: [],
  },
  localArtifact: {
    path: "/private/archive",
    sha256: "b".repeat(64),
    revision: "c".repeat(40),
    entrypoint: "dist/bin.mjs",
    runtimeExecutable: "node",
  },
  egressAllow: [],
});

it.effect(
  "ready survives a lost lease receipt, attachment uses fresh grants, and heartbeat extends compute before the lease",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProvisionOperationStore;
      const actual = createProvisionedLeaseRegistry(sql);
      const calls: string[] = [];
      let loseLeaseReply = true;
      let rejectTouch = false;
      let grants = 0;
      const ports: ProvisionProviderPorts["Service"] = {
        create: () =>
          Effect.sync(() => {
            calls.push("create");
            return { provider: "e2b" as const, sandboxId: "sandbox" };
          }),
        recoverCreate: () => Effect.succeed([]),
        fork: () => Effect.die("unexpected fork"),
        recoverFork: () => Effect.succeed([]),
        dispose: () => Effect.void,
        prepare: () =>
          Effect.sync(() => {
            calls.push("prepare");
            return {
              environmentId: EnvironmentId.make("remote"),
              projectDir: "/private/operation/workspace",
              sourceRevision: null,
              preparationHash: "a".repeat(64),
              t3Revision: "c".repeat(40),
              artifactSha256: "b".repeat(64),
            };
          }),
      };
      const provisioning = yield* Provisioning.make.pipe(
        Effect.provideService(ProvisionProviderPorts, ports),
      );
      const leases = {
        ...actual,
        register: async (...args: Parameters<typeof actual.register>) => {
          const result = await actual.register(...args);
          if (loseLeaseReply) {
            loseLeaseReply = false;
            throw new Error("lost durable lease reply");
          }
          return result;
        },
        touch: async (...args: Parameters<typeof actual.touch>) => {
          calls.push("touch-lease");
          return actual.touch(...args);
        },
      };
      const make = () =>
        makeProvisionControl(
          store,
          provisioning,
          {
            freeze: async () => manifest,
            load: async () => manifest,
            attach: async () => ({
              pairingUrl: `https://remote/pair#token=grant-${++grants}`,
              remoteAccess: { origin: "https://remote", brokerToken: "private-broker" },
            }),
            touch: async () => {
              calls.push("touch-provider");
              if (rejectTouch) throw new Error("provider unavailable");
              return "running" as const;
            },
          },
          leases,
        );
      expect((yield* make().provision(input).pipe(Effect.result))._tag).toBe("Failure");
      const ready = yield* make().provision(input);
      expect(ready).toMatchObject({
        kind: "ready",
        requestId: input.requestId,
        environment: {
          environmentId: "remote",
          leaseId: input.requestId,
          sandboxId: "sandbox",
          control: { brokerCredentialPath: "/private/operation/broker-token" },
        },
      });
      expect(calls).toEqual(["create", "prepare"]);
      expect(yield* make().attach({ requestId: input.requestId })).toEqual({
        kind: "attached",
        environmentId: "remote",
        pairingUrl: "https://remote/pair#token=grant-1",
      });
      expect(yield* make().attach({ requestId: input.requestId })).toEqual({
        kind: "attached",
        environmentId: "remote",
        pairingUrl: "https://remote/pair#token=grant-2",
      });
      yield* Effect.promise(() =>
        actual.claim({
          leaseId: input.requestId,
          owner: { environmentId: "remote", threadId: "thread" },
        }),
      );
      expect(yield* make().touch({ leaseId: input.requestId })).toEqual({ kind: "touched" });
      expect(calls.slice(-2)).toEqual(["touch-provider", "touch-lease"]);
      rejectTouch = true;
      expect((yield* make().touch({ leaseId: input.requestId }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(calls.slice(-2)).toEqual(["touch-lease", "touch-provider"]);
      yield* Effect.promise(() => actual.markDisposed(input.requestId));
      expect(yield* make().provision(input)).toMatchObject({ kind: "refused", reason: "disposed" });
      expect(yield* make().attach({ requestId: input.requestId })).toMatchObject({
        kind: "refused",
      });
    }).pipe(
      Effect.provide(
        ProvisionOperationStore.layer.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

const namespaceInput = Schema.decodeUnknownSync(EnvironmentProvisionInput)({
  requestId: "9c1f2d6e-7d0a-4a7f-9d4e-2b1c3a5e7f90",
  provider: "namespace",
  providerInstanceId: "codex",
});
const namespaceManifest = Schema.decodeUnknownSync(ProvisionPreparationManifest)({
  ...manifest,
  input: namespaceInput,
  request: {
    ...namespaceInput,
    sourceRevision: null,
    preparationHash: "a".repeat(64),
    creator: "user",
    tenantId: "tenant",
    size: "m",
    image: "tahoe",
    region: "iad",
    idleTimeoutMinutes: 30,
  },
  preparation: { ...manifest.preparation, requestId: namespaceInput.requestId },
});

it.effect(
  "records the loopback origin a Namespace attach published and hands it to the next attach",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProvisionOperationStore;
      const leases = createProvisionedLeaseRegistry(sql);
      const resource = {
        provider: "namespace" as const,
        devboxId: "box",
        devboxName: `t3-${namespaceInput.requestId}`,
        instanceId: "instance",
        region: "iad",
        workspaceDir: "/Users/runner/workspaces",
      };
      const provisioning = yield* Provisioning.make.pipe(
        Effect.provideService(ProvisionProviderPorts, {
          create: () => Effect.succeed(resource),
          recoverCreate: () => Effect.succeed([]),
          fork: () => Effect.die("unexpected fork"),
          recoverFork: () => Effect.succeed([]),
          dispose: () => Effect.void,
          prepare: () =>
            Effect.succeed({
              environmentId: EnvironmentId.make("remote"),
              projectDir: "/private/operation/workspace",
              sourceRevision: null,
              preparationHash: "a".repeat(64),
              t3Revision: "c".repeat(40),
              artifactSha256: "b".repeat(64),
            }),
        }),
      );
      const received: Array<unknown> = [];
      let grants = 0;
      const namespaceProxy = { proxyId: "provision-box", proxyOrigin: "http://127.0.0.1:50766" };
      const control = makeProvisionControl(
        store,
        provisioning,
        {
          freeze: async () => namespaceManifest,
          load: async () => namespaceManifest,
          attach: async (_operation, _manifest, recordedProxy) => {
            received.push(recordedProxy);
            return {
              pairingUrl: `${namespaceProxy.proxyOrigin}/pair#token=grant`,
              namespaceProxy,
              remoteAccess: {
                origin: namespaceProxy.proxyOrigin,
                brokerToken: `broker-${++grants}`,
              },
            };
          },
          touch: async () => "running" as const,
        },
        leases,
      );
      expect(yield* control.provision(namespaceInput)).toMatchObject({ kind: "ready" });
      expect(yield* control.attach({ requestId: namespaceInput.requestId })).toEqual({
        kind: "attached",
        environmentId: "remote",
        pairingUrl: "http://127.0.0.1:50766/pair#token=grant",
      });
      expect(yield* Effect.promise(() => leases.findById(namespaceInput.requestId))).toMatchObject({
        state: "active",
        namespaceProxy,
        remoteAccess: { origin: "http://127.0.0.1:50766", brokerToken: "broker-1" },
      });
      yield* control.attach({ requestId: namespaceInput.requestId });
      expect(received).toEqual([undefined, namespaceProxy]);
      expect(yield* Effect.promise(() => leases.findById(namespaceInput.requestId))).toMatchObject({
        remoteAccess: { origin: "http://127.0.0.1:50766", brokerToken: "broker-2" },
      });
    }).pipe(
      Effect.provide(
        ProvisionOperationStore.layer.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "a heartbeat the provider answers with a gone box refuses as missing and marks the lease",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProvisionOperationStore;
      const leases = createProvisionedLeaseRegistry(sql);
      let provider: "running" | "missing" = "running";
      const provisioning = yield* Provisioning.make.pipe(
        Effect.provideService(ProvisionProviderPorts, {
          create: () => Effect.succeed({ provider: "e2b" as const, sandboxId: "sandbox" }),
          recoverCreate: () => Effect.succeed([]),
          fork: () => Effect.die("unexpected fork"),
          recoverFork: () => Effect.succeed([]),
          dispose: () => Effect.void,
          prepare: () =>
            Effect.succeed({
              environmentId: EnvironmentId.make("remote"),
              projectDir: "/private/operation/workspace",
              sourceRevision: null,
              preparationHash: "a".repeat(64),
              t3Revision: "c".repeat(40),
              artifactSha256: "b".repeat(64),
            }),
        }),
      );
      const control = makeProvisionControl(
        store,
        provisioning,
        {
          freeze: async () => manifest,
          load: async () => manifest,
          attach: async () => ({
            pairingUrl: "https://remote/pair#token=grant",
            remoteAccess: { origin: "https://remote", brokerToken: "private-broker" },
          }),
          touch: async () => provider,
        },
        leases,
      );
      expect(yield* control.provision(input)).toMatchObject({ kind: "ready" });
      yield* Effect.promise(() =>
        leases.claim({
          leaseId: input.requestId,
          owner: { environmentId: "remote", threadId: "thread" },
        }),
      );
      expect(yield* control.touch({ leaseId: input.requestId })).toEqual({ kind: "touched" });
      provider = "missing";
      const missing = {
        kind: "refused",
        reason: "missing",
        message: "The provider no longer has this workspace. It cannot be reconnected.",
      };
      expect(yield* control.touch({ leaseId: input.requestId })).toEqual(missing);
      expect(yield* Effect.promise(() => leases.findById(input.requestId))).toMatchObject({
        state: "missing",
      });
      expect(yield* control.touch({ leaseId: input.requestId })).toEqual(missing);
      expect(yield* control.attach({ requestId: input.requestId })).toMatchObject({
        kind: "refused",
      });
    }).pipe(
      Effect.provide(
        ProvisionOperationStore.layer.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);

it.effect.each(["attach", "touch"] as const)(
  "expired ready requests dispose instead of issuing %s effects",
  (action) =>
    Effect.gen(function* () {
      const store = yield* ProvisionOperationStore;
      const request = { ...manifest.request, retentionDeadline: "1960-01-01T00:00:00.000Z" };
      const calls: string[] = [];
      yield* store.advance(yield* store.accept(request), {
        kind: "ready",
        allocation: { kind: "direct", resource: { provider: "e2b", sandboxId: "expired" } },
        readiness: {
          environmentId: EnvironmentId.make("expired"),
          projectDir: "/private",
          sourceRevision: null,
          preparationHash: request.preparationHash,
          artifactSha256: "b".repeat(64),
          t3Revision: "c".repeat(40),
        },
      });
      const provisioning = yield* Provisioning.make.pipe(
        Effect.provideService(ProvisionProviderPorts, {
          create: () => Effect.die("Unexpected create"),
          recoverCreate: () => Effect.die("Unexpected recovery"),
          fork: () => Effect.die("Unexpected fork"),
          recoverFork: () => Effect.die("Unexpected recovery"),
          prepare: () => Effect.die("Unexpected prepare"),
          dispose: () =>
            Effect.sync(() => {
              calls.push("dispose");
            }),
        }),
      );
      const control = makeProvisionControl(
        store,
        provisioning,
        {
          freeze: async () => manifest,
          load: async () => manifest,
          attach: async () => {
            throw new Error("Expired attach must not issue a grant");
          },
          touch: async () => {
            throw new Error("Expired touch must not renew compute");
          },
        },
        createProvisionedLeaseRegistry(yield* SqlClient.SqlClient),
      );
      const result =
        action === "attach"
          ? yield* control.attach({ requestId: input.requestId })
          : yield* control.touch({ leaseId: input.requestId });
      expect(result.kind).toBe("refused");
      expect(calls).toEqual(["dispose"]);
      expect((yield* store.get(input.requestId)).state).toEqual({ kind: "disposed" });
    }).pipe(
      Effect.provide(
        ProvisionOperationStore.layer.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
