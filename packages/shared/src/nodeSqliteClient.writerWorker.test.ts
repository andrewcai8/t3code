import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as SqliteClient from "./nodeSqliteClient.ts";

const workers = vi.hoisted(() => ({
  started: [] as Array<{
    readonly workerData: { readonly requireWal?: unknown } | undefined;
    readonly worker: NodeWorkerThreads.Worker;
  }>,
  afterPost: undefined as
    | ((worker: NodeWorkerThreads.Worker, message: unknown) => void)
    | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.started.push({ workerData: args[1]?.workerData, worker: this });
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      super.postMessage(...args);
      workers.afterPost?.(this, args[0]);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const latestWriter = () =>
  workers.started.findLast((entry) => entry.workerData?.requireWal === false)!.worker;

/** The worker's reply to the next statement containing `marker` fails to deserialize. */
const failReplyTo = (marker: string) => {
  workers.afterPost = (worker, message) => {
    if (typeof message !== "object" || message === null || !("sql" in message)) return;
    if (!String(message.sql).includes(marker)) return;
    workers.afterPost = undefined;
    queueMicrotask(() => worker.emit("messageerror", new Error("simulated clone failure")));
  };
};

const tempDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-writer-" });
  return path.join(directory, "state.sqlite");
});

const clientLayer = (filename: string) =>
  SqliteClient.layer({ filename, writerWorker: true, readerWorker: true });

const withClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(clientLayer(filename)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect("commits a transaction's statements together and shows them to readers after", () =>
  withClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(value INTEGER NOT NULL)`;
      const failure = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries VALUES (1)`;
            yield* sql`INSERT INTO entries VALUES (2)`;
            return yield* Effect.fail("abort" as const);
          }),
        )
        .pipe(Effect.flip);
      assert.equal(failure, "abort");
      assert.equal(yield* countEntries(sql), 0);

      const inserted = yield* Deferred.make<void>();
      const commit = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO entries VALUES (3)`;
            yield* sql`INSERT INTO entries VALUES (4)`;
            yield* Deferred.succeed(inserted, undefined);
            yield* Deferred.await(commit);
          }),
        ),
      );
      yield* Deferred.await(inserted);
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 0);
      yield* Deferred.succeed(commit, undefined);
      yield* Fiber.join(writer);
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 2);
    }),
  ),
);

it.effect("keeps each caller's statements in order and each transaction whole", () =>
  withClient((sql) =>
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE entries(id INTEGER PRIMARY KEY, batch INTEGER NOT NULL, step INTEGER NOT NULL)
      `;
      const steps = [0, 1, 2, 3, 4];
      const insertSteps = (batch: number) =>
        Effect.forEach(
          steps,
          (step) => sql`INSERT INTO entries(batch, step) VALUES (${batch}, ${step})`,
          { discard: true },
        );
      const batches = [0, 1, 2, 3, 4, 5, 6, 7];
      yield* Effect.forEach(
        batches,
        // Even batches are transactions, odd ones separate statements.
        (batch) => (batch % 2 === 0 ? sql.withTransaction(insertSteps(batch)) : insertSteps(batch)),
        { concurrency: "unbounded", discard: true },
      );

      const rows = yield* sql<{ readonly batch: number; readonly step: number }>`
        SELECT batch, step FROM entries ORDER BY id
      `;
      for (const batch of batches) {
        const positions = rows.flatMap((row, index) => (row.batch === batch ? [index] : []));
        assert.deepEqual(
          positions.map((index) => rows[index]!.step),
          steps,
        );
        if (batch % 2 === 0) {
          assert.equal(positions.at(-1)! - positions[0]!, steps.length - 1);
        }
      }
    }),
  ),
);

it.effect("finishes a statement sent before close and fails the ones after", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const scope = yield* Scope.make();
    const sql = Context.get(
      yield* Layer.buildWithScope(clientLayer(filename), scope),
      SqlClient.SqlClient,
    );
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`CREATE TABLE entries(value INTEGER NOT NULL)`;

    const sent = yield* Effect.forkChild(
      sql`
        INSERT INTO entries
        WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000)
        SELECT x FROM c
      `,
      { startImmediately: true },
    );
    const queued = yield* Effect.forkChild(sql`INSERT INTO entries VALUES (0)`, {
      startImmediately: true,
    });
    yield* Scope.close(scope, Exit.void);

    yield* Fiber.join(sent);
    const error = yield* Fiber.join(queued).pipe(Effect.flip);
    assert.include(String(error.reason.cause), "Database writer exited");
    const reopened = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
    try {
      assert.deepEqual(reopened.prepare("SELECT COUNT(*) AS count FROM entries").get(), {
        count: 200_000,
      });
    } finally {
      reopened.close();
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const slowCount = (sql: SqlClient.SqlClient) =>
  sql<{ readonly n: number }>`
    WITH RECURSIVE slow(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM slow WHERE x < 2000000)
    SELECT COUNT(*) AS n FROM slow
  `;

it.effect("fails a statement whose reply cannot be read and reports the writer lost", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const lost: Array<string> = [];
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER NOT NULL)`;
      failReplyTo("WITH RECURSIVE slow");
      const error = yield* slowCount(sql).pipe(Effect.flip);
      assert.include(String(error.reason.cause), "Database writer reply could not be read");
      const next = yield* sql`INSERT INTO entries VALUES (1)`.pipe(Effect.flip);
      assert.include(String(next.reason.cause), "Database writer reply could not be read");
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename, writerWorker: true, onWriterLost: (r) => lost.push(r) }),
      ),
      Effect.scoped,
    );
    assert.equal(lost.length, 1);
    assert.include(lost[0], "Database writer reply could not be read");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails a read whose reply cannot be read, then keeps reading", () =>
  withClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(value INTEGER NOT NULL)`;
      yield* sql`INSERT INTO entries VALUES (1)`;
      failReplyTo("WITH RECURSIVE slow");
      const error = yield* slowCount(sql).pipe(SqliteClient.readOnly, Effect.flip);
      assert.include(String(error.reason.cause), "Database reader reply could not be read");
      assert.equal(yield* countEntries(sql).pipe(SqliteClient.readOnly), 1);
    }),
  ),
);

it.effect("reports a writer worker that stops on its own, not one closed at shutdown", () =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    const lost: Array<string> = [];
    let report: (reason: string) => void = () => {};
    const reported = new Promise<string>((resolve) => {
      report = resolve;
    });
    const layer = SqliteClient.layer({
      filename,
      writerWorker: true,
      onWriterLost: (reason) => {
        lost.push(reason);
        report(reason);
      },
    });

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE entries(value INTEGER NOT NULL)`;
    }).pipe(Effect.provide(layer), Effect.scoped);
    // The close finalizer has seen the worker exit by now.
    yield* eventLoopTurn;
    assert.deepEqual(lost, []);

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Effect.promise(() => latestWriter().terminate());
      assert.include(yield* Effect.promise(() => reported), "Database writer exited");
      const error = yield* sql`INSERT INTO entries VALUES (1)`.pipe(Effect.flip);
      assert.include(String(error.reason.cause), "Database writer exited");
    }).pipe(Effect.provide(layer), Effect.scoped);
    assert.equal(lost.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
