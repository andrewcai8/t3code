// @effect-diagnostics nodeBuiltinImport:off - small records beside this host's state, written in place.
/**
 * What a restarted server needs to adopt a worktree fork whose command was already running
 * (WorktreeForks.ts). A server is usually killed rather than shut down, so nothing here waits for
 * a clean exit: each record is written whole before its command's banner and renamed into place,
 * and is gone only once the job has ended.
 *
 * `<stateDir>/worktree-forks/jobs/<job>/` holds a job's `job.json` and, once its outputs start
 * coming back, a `copy-back` marker created exclusively, so a stale record or a second server
 * never copies them twice. Batches keep `batch.json` in their results directory, so
 * t3_fork_status answers across a restart too.
 *
 * @module worktreeForkJobs
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { FleetForkJobState, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const JobRecord = Schema.Struct({
  id: Schema.String,
  sandboxId: Schema.String,
  caller: Schema.Literals(["bun-shim", "fork-exec", "fork-run"]),
  command: Schema.String,
  cwd: Schema.String,
  repository: Schema.String,
  size: Schema.Struct({ cpu: Schema.Number, memoryMiB: Schema.Number }),
  /** Null for `t3 fork-exec`, whose caller re-attaches by the job's id. */
  batch: Schema.NullOr(Schema.Struct({ id: Schema.String, owner: ThreadId, index: Schema.Int })),
  /** When the command was launched; its deadline is `startedAt + timeoutMs`. */
  startedAt: Schema.Number,
  timeoutMs: Schema.Number,
  outputs: Schema.NullOr(
    Schema.Struct({
      paths: Schema.Array(Schema.String),
      root: Schema.String,
      into: Schema.String,
      archive: Schema.String,
      place: Schema.optional(Schema.Literal(true)),
    }),
  ),
  /** Where a server that adopts the job writes its stdout.log and stderr.log. */
  logs: Schema.String,
});
export type JobRecord = typeof JobRecord.Type;

export const BatchRecord = Schema.Struct({
  owner: ThreadId,
  jobs: Schema.Array(FleetForkJobState),
  finishedAt: Schema.NullOr(Schema.Number),
});
export type BatchRecord = typeof BatchRecord.Type;

const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(JobRecord));
const decodeBatch = Schema.decodeUnknownSync(Schema.fromJsonString(BatchRecord));

/** Writes beside `path` and renames over it, so a reader never sees half a file. */
const writeWhole = (path: string, value: unknown) => {
  const part = `${path}.part`;
  NodeFS.writeFileSync(part, JSON.stringify(value));
  NodeFS.renameSync(part, path);
};

export const jobsRoot = (stateDir: string) => NodePath.join(stateDir, "worktree-forks", "jobs");
export const jobDir = (root: string, id: string) => NodePath.join(root, id);

export const writeJob = (root: string, record: JobRecord) => {
  NodeFS.mkdirSync(jobDir(root, record.id), { recursive: true });
  writeWhole(NodePath.join(jobDir(root, record.id), "job.json"), record);
};

export const removeJobDir = (root: string, id: string) =>
  NodeFS.rmSync(jobDir(root, id), { recursive: true, force: true });

/**
 * True for the one caller that may copy the job's outputs back. A job whose directory is gone has
 * ended, so its outputs are no one's to copy.
 */
export const claimCopyBack = (root: string, id: string): boolean => {
  try {
    NodeFS.writeFileSync(NodePath.join(jobDir(root, id), "copy-back"), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
};

/**
 * The records a previous run left. Directories without one are leftovers of ended jobs and go;
 * a record that does not decode goes too, and is named in `unreadable`.
 */
export const readJobs = (root: string) => {
  const records: Array<JobRecord> = [];
  const unreadable: Array<string> = [];
  for (const id of NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : []) {
    const path = NodePath.join(jobDir(root, id), "job.json");
    try {
      records.push(decodeJob(NodeFS.readFileSync(path, "utf8")));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(path);
      removeJobDir(root, id);
    }
  }
  return { records, unreadable };
};

export const writeBatch = (resultsDir: string, record: BatchRecord) => {
  NodeFS.mkdirSync(resultsDir, { recursive: true });
  writeWhole(NodePath.join(resultsDir, "batch.json"), record);
};

/** The batch a previous run kept in `resultsDir`, or null when it kept none. */
export const readBatch = (resultsDir: string): BatchRecord | null => {
  try {
    return decodeBatch(NodeFS.readFileSync(NodePath.join(resultsDir, "batch.json"), "utf8"));
  } catch {
    return null;
  }
};
