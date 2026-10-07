import * as Schema from "effect/Schema";

/**
 * What a cloud box writes beside the backup it takes before it sleeps, and what a restore reads to
 * bring its chat back on a fresh box. `version` changes only with a change restore cannot read.
 */
export const CloudBackupManifest = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: Schema.String,
  leaseId: Schema.String,
  /** The host account the box ran its chat on. */
  account: Schema.String,
  threadId: Schema.String,
  title: Schema.NullOr(Schema.String),
  modelSelection: Schema.NullOr(Schema.Unknown),
  workspace: Schema.String,
  repository: Schema.NullOr(Schema.String),
  /** The branch the workspace had checked out, its commit, and whether origin has that branch. */
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  branchOnOrigin: Schema.Boolean,
  /** The origin's default branch, which a restore starts from when origin lacks `branch`. */
  defaultBranch: Schema.NullOr(Schema.String),
  /** The `t3-backup/` branches holding work only the box had, on origin or in `bundle`. */
  backupBranches: Schema.Array(Schema.String),
  /**
   * The key of a git bundle holding `backupBranches` as `refs/t3-bundle/<branch>`, when origin is
   * not private and the work was kept here instead of pushed there. Null when it was pushed.
   */
  bundle: Schema.NullOr(Schema.String),
  /** The chat's provider sessions, oldest first, each with its files' keys under the backup. */
  sessions: Schema.Array(
    Schema.Struct({
      driver: Schema.String,
      instanceId: Schema.String,
      nativeId: Schema.String,
      files: Schema.Array(Schema.String),
    }),
  ),
});
export type CloudBackupManifest = typeof CloudBackupManifest.Type;

/** Where a box's latest backup lives under a host's outputs bucket, `s3://bucket/prefix`. */
export const cloudBackupUri = (outputsUri: string, environmentId: string) =>
  `${outputsUri.replace(/\/+$/, "")}/${environmentId}/backups/latest/`;
