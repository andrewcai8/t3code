// @effect-diagnostics nodeBuiltinImport:off - independent Node processes exercise the SQLite ownership boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DurableProvisionRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ProvisionOperationStore } from "./ProvisionOperationStore.ts";

const decodeRequest = Schema.decodeUnknownEffect(DurableProvisionRequest);

const contenderSource = `
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import * as SqlClient from 'effect/unstable/sql/SqlClient';
import { createProvisionedLeaseRegistry } from './src/environmentControl/ProvisionedLeaseRegistry.ts';
import { ProvisionRequestId } from '@t3tools/contracts';
import { ProvisionOperationStore } from './src/environmentControl/ProvisionOperationStore.ts';
import { makeSqlitePersistenceLive } from './src/persistence/Layers/Sqlite.ts';
const layer = ProvisionOperationStore.layer.pipe(
  Layer.provideMerge(makeSqlitePersistenceLive(process.argv[1])),
  Layer.provide(NodeServices.layer),
);
NodeRuntime.runMain(Effect.gen(function* () {
  const store = yield* ProvisionOperationStore;
  const before = yield* store.get(Schema.decodeUnknownSync(ProvisionRequestId)(process.argv[2]));
  yield* Effect.promise(() => new Promise(resolve => {
    process.stdin.once('data', () => { process.stdin.destroy(); resolve(); });
    process.stdout.write('loaded\\n');
  }));
  const result = yield* store.advance(before, { kind: 'create_issued' });
  process.stdout.write(result.changed ? 'winner\\n' : 'observed\\n');
  const registry = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
  yield* Effect.promise(async () => {
    await Promise.all(Array.from({length:20}, (_, index) => registry.register({leaseId: process.pid+'-'+index, sandboxId: process.pid+'-'+index, providerInstanceId:'codex'})));
    await registry.register({leaseId:'shared',sandboxId:'shared',providerInstanceId:'codex'});
    const claimed = await registry.claim({leaseId:'shared',owner:{environmentId:'remote',threadId:String(process.pid)}});
    process.stdout.write(claimed ? 'lease-winner\\n' : 'lease-observed\\n');
  });
}).pipe(Effect.provide(layer), Effect.scoped));
`;

function contender(file: string, requestId: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    ["--input-type=module", "-e", contenderSource, file, requestId],
    {
      cwd: NodeURL.fileURLToPath(new URL("../../", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += chunk;
  });
  const loaded = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("loaded\n")) resolve();
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      reject(new Error(`Contender exited before loading (${code}): ${error}`)),
    );
  });
  const completed = new Promise<{ code: number | null; output: string; error: string }>(
    (resolve) => {
      child.on("error", (cause) => resolve({ code: 1, output, error: cause.message }));
      child.on("exit", (code) => resolve({ code, output, error }));
    },
  );
  return { child, loaded, completed };
}

it.effect("two server processes cannot both claim the same allocation effect", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "provision-process-" });
    const file = path.join(directory, "state.sqlite");
    const request = yield* decodeRequest({
      requestId: "df378e5b-7d83-4392-a73f-94eb6c5674e2",
      provider: "e2b",
      providerInstanceId: "codex",
      sourceRevision: null,
      preparationHash: "b".repeat(64),
      templateId: "template",
      strategy: "direct",
    });
    const storeLayer = ProvisionOperationStore.layer.pipe(
      Layer.provide(makeSqlitePersistenceLive(file)),
      Layer.provide(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      yield* (yield* ProvisionOperationStore).accept(request);
    }).pipe(Effect.provide(storeLayer), Effect.scoped);
    const contenders = yield* Effect.acquireRelease(
      Effect.sync(() => [contender(file, request.requestId), contender(file, request.requestId)]),
      (children) =>
        Effect.sync(() => {
          for (const { child } of children) if (child.exitCode === null) child.kill();
        }),
    );
    yield* Effect.promise(() => Promise.all(contenders.map((entry) => entry.loaded)));
    for (const { child } of contenders) child.stdin.write("go\n");
    const results = yield* Effect.promise(() =>
      Promise.all(contenders.map((entry) => entry.completed)),
    );
    for (const result of results) expect(result.code, result.error).toBe(0);
    expect(results.map((result) => result.output.split("\n")[1]).toSorted()).toEqual([
      "observed",
      "winner",
    ]);
    expect(results.map((result) => result.output.split("\n")[2]).toSorted()).toEqual([
      "lease-observed",
      "lease-winner",
    ]);
    const leaseCount = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM provisioned_leases`;
    }).pipe(Effect.provide(makeSqlitePersistenceLive(file)), Effect.scoped);
    expect(leaseCount[0]?.count).toBe(41);
    const persisted = yield* Effect.gen(function* () {
      return yield* (yield* ProvisionOperationStore).get(request.requestId);
    }).pipe(Effect.provide(storeLayer), Effect.scoped);
    expect(persisted.revision).toBe(1);
    expect(persisted.state).toEqual({ kind: "create_issued" });
    expect(persisted.request).toEqual(request);
  }).pipe(Effect.provide(NodeServices.layer)),
);
