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
  started: [] as Array<{ readonly source: unknown; readonly worker: NodeWorkerThreads.Worker }>,
  afterPost: undefined as
    | ((worker: NodeWorkerThreads.Worker, message: unknown) => void)
    | undefined,
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.started.push({ source: args[0], worker: this });
    }
    override postMessage(...args: Parameters<NodeWorkerThreads.Worker["postMessage"]>) {
      super.postMessage(...args);
      workers.afterPost?.(this, args[0]);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

const WRITER_SOURCE_MARKER = "admission: true";
const latestWorker = (marker: string) =>
  workers.started.findLast((entry) => String(entry.source).includes(marker))!.worker;

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

const clientLayer = (filename: string, writerWorker = true) =>
  SqliteClient.layer({ filename, writerWorker, readerWorker: true, checkpointWorker: true });

const withClient = <A, E>(
  use: (
    sql: SqlClient.SqlClient,
    filename: string,
  ) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
  writerWorker = true,
) =>
  Effect.gen(function* () {
    const filename = yield* tempDatabase;
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      return yield* use(sql, filename);
    }).pipe(Effect.provide(clientLayer(filename, writerWorker)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const countEntries = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM entries`,
    (rows) => rows[0]?.count,
  );

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const eventLoopTurn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

it.effect("runs writer statements without blocking the event loop", () =>
  withClient((sql) =>
    Effect.gen(function* () {
      const count = yield* Effect.forkChild(
        sql<{ readonly n: number }>`
          WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000)
          SELECT COUNT(*) AS n FROM c
        `,
        { startImmediately: true },
      );
      // On the main thread the statement would finish before this turn could run.
      yield* eventLoopTurn;
      assert.isUndefined(count.pollUnsafe());
      assert.deepEqual(yield* Fiber.join(count), [{ n: 2_000_000 }]);
    }),
  ),
);

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

it.effect("reports SQLite failures from the worker as typed errors", () =>
  withClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE constrained(name TEXT NOT NULL UNIQUE)`;
      yield* sql`INSERT INTO constrained VALUES ('taken')`;

      const duplicate = yield* sql`INSERT INTO constrained VALUES ('taken')`.pipe(Effect.flip);
      assert(duplicate.reason._tag === "UniqueViolation");
      assert.equal(duplicate.reason.constraint, "constrained.name");

      const missing = yield* sql`SELECT name FROM never_created`.pipe(Effect.flip);
      assert.equal(missing.reason.operation, "prepare");

      yield* sql`PRAGMA busy_timeout = 0`;
      const other = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
        (database) => Effect.sync(() => database.close()),
      );
      yield* Effect.sync(() => other.exec("BEGIN IMMEDIATE"));
      const locked = yield* sql.withTransaction(sql`SELECT 1`).pipe(Effect.flip);
      assert.equal(locked.reason._tag, "LockTimeoutError");
      yield* Effect.sync(() => other.exec("COMMIT"));
      assert.deepEqual(yield* sql`SELECT name FROM constrained`.values, [["taken"]]);
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
    assert.include(String(error.reason.cause), "Database writer is closed");
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

// The checkpoint worker holds writes at this many WAL frames until it can reset the log.
const CHECKPOINT_BACKPRESSURE_FRAMES = 10_000;

const walFrames = (sql: SqlClient.SqlClient) =>
  Effect.map(
    sql<{ readonly log: number }>`PRAGMA wal_checkpoint(NOOP)`,
    (rows) => rows[0]?.log ?? 0,
  );

it.effect("runs a write held for checkpoint admission once", () =>
  withClient((sql, filename) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE blobs(data BLOB NOT NULL)`;
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeSqlite.DatabaseSync(filename, { readOnly: true })),
        (database) => Effect.sync(() => database.close()),
      );
      // An open read keeps the checkpoint from passing its snapshot.
      yield* Effect.sync(() => {
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) AS count FROM blobs").get();
      });
      const blob = new Uint8Array(256 * 1024);
      let inserted = 0;
      while ((yield* walFrames(sql)) < CHECKPOINT_BACKPRESSURE_FRAMES) {
        yield* sql`INSERT INTO blobs VALUES (${blob})`;
        inserted++;
      }

      const held = yield* Effect.forkChild(sql`INSERT INTO blobs VALUES (${blob})`, {
        startImmediately: true,
      });
      yield* Effect.sync(() => reader.exec("COMMIT"));
      yield* Fiber.join(held);
      assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM blobs`.values, [[inserted + 1]]);
    }),
  ),
);

it.effect.each([{ writerWorker: false }, { writerWorker: true }])(
  "keeps checkpointing the WAL (writerWorker=$writerWorker)",
  ({ writerWorker }) =>
    withClient(
      (sql) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* sql`PRAGMA wal_autocheckpoint`.values, [[0]]);
          yield* sql`CREATE TABLE blobs(data BLOB NOT NULL)`;
          // 64 pages each, about 11,000 frames in all: past the ceiling.
          const blob = new Uint8Array(256 * 1024);
          for (let index = 0; index < 170; index++) {
            yield* sql`INSERT INTO blobs VALUES (${blob})`;
          }
          const [frames] = yield* sql<{
            readonly log: number;
            readonly checkpointed: number;
          }>`PRAGMA wal_checkpoint(NOOP)`;
          assert.isBelow(frames!.log, CHECKPOINT_BACKPRESSURE_FRAMES + 100);
        }),
      writerWorker,
    ),
);

const slowCount = (sql: SqlClient.SqlClient) =>
  sql<{ readonly n: number }>`
    WITH RECURSIVE slow(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM slow WHERE x < 2000000)
    SELECT COUNT(*) AS n FROM slow
  `;

it.effect("fails a statement whose reply cannot be read, then keeps writing", () =>
  withClient((sql) =>
    Effect.gen(function* () {
      yield* sql`CREATE TABLE entries(value INTEGER NOT NULL)`;
      failReplyTo("WITH RECURSIVE slow");
      const error = yield* slowCount(sql).pipe(Effect.flip);
      assert.include(String(error.reason.cause), "Database writer reply could not be read");
      yield* sql`INSERT INTO entries VALUES (1)`;
      assert.equal(yield* countEntries(sql), 1);
    }),
  ),
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
      yield* Effect.promise(() => latestWorker(WRITER_SOURCE_MARKER).terminate());
      assert.include(yield* Effect.promise(() => reported), "Database writer exited");
      const error = yield* sql`INSERT INTO entries VALUES (1)`.pipe(Effect.flip);
      assert.include(String(error.reason.cause), "Database writer exited");
    }).pipe(Effect.provide(layer), Effect.scoped);
    assert.equal(lost.length, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
