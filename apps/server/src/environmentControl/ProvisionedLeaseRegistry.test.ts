// @effect-diagnostics globalDate:off - lease tests use fixed timestamps.
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import {
  createProvisionedLeaseRegistry,
  type ProvisionedLeaseRegistry,
} from "./ProvisionedLeaseRegistry.ts";

const withRegistry = (
  body: (registry: ProvisionedLeaseRegistry, second: ProvisionedLeaseRegistry) => Promise<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const database = path.join(directory, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.promise(() =>
        body(createProvisionedLeaseRegistry(sql), createProvisionedLeaseRegistry(sql)),
      );
    }).pipe(Effect.provide(makeSqlitePersistenceLive(database)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect(
  "concurrent registry instances retain every lease and permit only one conflicting claim",
  () =>
    withRegistry(async (first, second) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 ? first : second).register({
            leaseId: `lease-${index}`,
            sandboxId: `sandbox-${index}`,
            providerInstanceId: "codex",
          }),
        ),
      );
      for (let index = 0; index < 20; index += 1)
        expect(await second.findBySandbox(`sandbox-${index}`)).toMatchObject({
          leaseId: `lease-${index}`,
        });
      const claims = await Promise.all(
        [first, second].map((registry, index) =>
          registry.claim({
            leaseId: "lease-0",
            owner: { environmentId: "remote", threadId: `thread-${index}` },
          }),
        ),
      );
      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
      await expect(
        first.register({ leaseId: "lease-0", sandboxId: "different", providerInstanceId: "codex" }),
      ).rejects.toThrow("identity conflict");
    }),
);
it.effect("persists proxy identity, renews a claimed lease, and gives one release winner", () =>
  withRegistry(async (first, second) => {
    await first.register({
      leaseId: "lease",
      sandboxId: "sandbox",
      providerInstanceId: "codex",
      namespaceProxy: { proxyId: "proxy", proxyOrigin: "https://proxy.example" },
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(await second.findBySandbox("sandbox")).toMatchObject({
      namespaceProxy: { proxyId: "proxy", proxyOrigin: "https://proxy.example" },
    });
    expect(await second.expired(new Date("2026-01-01T00:14:59Z"))).toHaveLength(0);
    expect(await second.expired(new Date("2026-01-01T00:15:01Z"))).toHaveLength(1);
    const owner = { environmentId: "remote", threadId: "thread" };
    expect(await second.claim({ leaseId: "lease", owner })).not.toBeNull();
    expect(await first.claim({ leaseId: "lease", owner })).not.toBeNull();
    expect(await first.touch("lease", new Date("2026-01-01T00:15:00Z"))).toMatchObject({
      expiresAt: "2026-01-01T00:30:00.000Z",
    });
    expect(await first.touch("missing")).toBeNull();
    const releases = await Promise.all(
      [first, second].map((registry) =>
        registry.beginRelease({ leaseId: "lease", sandboxId: "sandbox" }),
      ),
    );
    expect(releases.sort()).toEqual(["busy", "started"]);
    await first.markDisposed("lease");
    expect(await second.beginRelease({ leaseId: "lease", sandboxId: "sandbox" })).toBe("disposed");
    expect(await second.touch("lease")).toBeNull();
  }),
);

it.effect("records the proxy an attach opened after registration and never lets it change", () =>
  withRegistry(async (first, second) => {
    const registration = { leaseId: "lease", sandboxId: "sandbox", providerInstanceId: "codex" };
    const proxy = { proxyId: "proxy", proxyOrigin: "http://127.0.0.1:50766" };
    const other = { ...proxy, proxyOrigin: "http://127.0.0.1:50767" };
    await first.register(registration);
    expect(await first.markActive({ leaseId: "lease", namespaceProxy: proxy })).toMatchObject({
      namespaceProxy: proxy,
    });
    expect(await second.register(registration)).toMatchObject({ namespaceProxy: proxy });
    expect(await second.markActive({ leaseId: "lease", namespaceProxy: proxy })).toMatchObject({
      namespaceProxy: proxy,
    });
    await expect(second.markActive({ leaseId: "lease", namespaceProxy: other })).rejects.toThrow(
      "identity conflict",
    );
    await expect(second.register({ ...registration, namespaceProxy: other })).rejects.toThrow(
      "identity conflict",
    );
    expect(await first.findBySandbox("sandbox")).toMatchObject({ namespaceProxy: proxy });
  }),
);

it.effect("imports existing JSON leases once without reviving a later disposal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const legacy =
      '[{"leaseId":"legacy","sandboxId":"legacy-sandbox","providerInstanceId":"codex","state":"active","owner":{"environmentId":"remote","threadId":"thread"},"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","expiresAt":"2026-01-01T00:15:00.000Z"}]';
    const first = createProvisionedLeaseRegistry(sql, legacy);
    expect(yield* Effect.promise(() => first.findBySandbox("legacy-sandbox"))).toMatchObject({
      owner: { environmentId: "remote", threadId: "thread" },
      expiresAt: "2026-01-01T00:15:00.000Z",
    });
    yield* Effect.promise(() => first.markDisposed("legacy"));
    const reopened = createProvisionedLeaseRegistry(sql, legacy);
    expect(yield* Effect.promise(() => reopened.findBySandbox("legacy-sandbox"))).toMatchObject({
      state: "disposed",
    });
  }).pipe(Effect.provide(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer)))),
);

it.effect(
  "immutable retention caps survive registry reload and bound every claim and heartbeat",
  () =>
    withRegistry(async (first, second) => {
      const cap = "2026-01-01T00:20:00.000Z";
      const input = {
        leaseId: "bounded",
        sandboxId: "bounded-box",
        providerInstanceId: "codex",
        retentionDeadline: cap,
        now: new Date("2026-01-01T00:00:00.000Z"),
      };
      expect(await first.register(input)).toMatchObject({
        expiresAt: "2026-01-01T00:15:00.000Z",
        retentionDeadline: cap,
      });
      await second.claim({
        leaseId: "bounded",
        owner: { environmentId: "env", threadId: "thread" },
        now: input.now,
      });
      expect(await second.touch("bounded", new Date("2026-01-01T00:10:00.000Z"))).toMatchObject({
        expiresAt: cap,
      });
      expect(await first.touch("bounded", new Date(cap))).toBeNull();
      expect(
        await first.claim({
          leaseId: "bounded",
          owner: { environmentId: "env", threadId: "thread" },
          now: new Date(cap),
        }),
      ).toBeNull();
      expect(await second.expired(new Date(cap))).toHaveLength(1);
      await expect(
        first.register({ ...input, retentionDeadline: "2026-01-01T00:30:00.000Z" }),
      ).rejects.toThrow("identity conflict");
      expect(await first.findBySandbox("bounded-box")).toMatchObject({
        expiresAt: cap,
        retentionDeadline: cap,
      });
    }),
);
