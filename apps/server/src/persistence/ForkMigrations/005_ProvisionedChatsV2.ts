import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Frozen with this migration: what a pre-V2 card needs for its V2 rewrite. It must not follow the
// live contracts, or each later shell change would alter what this migration converts.
const NullableText = Schema.optional(Schema.NullOr(Schema.String));
const isPreV2Card = Schema.is(
  Schema.Struct({
    project: Schema.Struct({
      id: Schema.NonEmptyString,
      title: Schema.NonEmptyString,
      workspaceRoot: Schema.NonEmptyString,
    }),
    thread: Schema.Struct({
      id: Schema.NonEmptyString,
      projectId: Schema.NonEmptyString,
      title: Schema.String,
      modelSelection: Schema.Struct({ model: Schema.String }),
      runtimeMode: Schema.Literals([
        "approval-required",
        "auto-accept-edits",
        "auto",
        "full-access",
      ]),
      interactionMode: Schema.optional(Schema.Literals(["default", "plan"])),
      branch: NullableText,
      worktreePath: NullableText,
      latestUserMessageAt: NullableText,
      createdAt: Schema.String,
      updatedAt: Schema.String,
    }),
  }),
);

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const orNull = (value: unknown) => (value === undefined ? null : value);
const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });

/**
 * A pre-V2 card's thread as a V2 thread shell, with no runs or items. Its sequence stays: the box's
 * V2 event log continues the same sequence, so the box's next read still replaces it.
 */
function v2Thread(v1: Json): Json | null {
  const id = text(v1.id);
  const modelSelection = record(v1.modelSelection);
  const instanceId =
    text(modelSelection?.instanceId) ??
    text(modelSelection?.provider) ??
    text(record(v1.session)?.providerInstanceId);
  if (id === null || modelSelection === null || instanceId === null) return null;
  return {
    createdBy: "system",
    creationSource: "server",
    id,
    projectId: v1.projectId,
    title: v1.title,
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: v1.runtimeMode,
    interactionMode: v1.interactionMode ?? "default",
    branch: orNull(v1.branch),
    worktreePath: orNull(v1.worktreePath),
    ...optional("linkedPullRequest", v1.linkedPullRequest),
    ...optional("pullRequests", v1.pullRequests),
    ...optional("branchPullRequest", v1.branchPullRequest),
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: orNull(v1.latestUserMessageAt),
    hasActionableProposedPlan: v1.hasActionableProposedPlan === true,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: v1.createdAt,
    updatedAt: v1.updatedAt,
    archivedAt: orNull(v1.archivedAt),
    settledOverride: orNull(v1.settledOverride),
    settledAt: orNull(v1.settledAt),
    ...optional("unsettledAt", v1.unsettledAt),
    ...optional("snoozedUntil", v1.snoozedUntil),
    ...optional("snoozedAt", v1.snoozedAt),
    ...optional("pinnedAt", v1.pinnedAt),
    ...optional("autoSettleDisabledAt", v1.autoSettleDisabledAt),
    ...optional("pinOrderKey", v1.pinOrderKey),
    ...optional("activeOrderKey", v1.activeOrderKey),
    deletedAt: null,
  };
}

type Rewrite =
  | { readonly kind: "converted"; readonly chatJson: string }
  | { readonly kind: "current" }
  | { readonly kind: "skipped"; readonly reason: string };

function v2Chat(chatJson: string): Rewrite {
  let chat: Json | null;
  try {
    chat = record(JSON.parse(chatJson));
  } catch {
    return { kind: "skipped", reason: "the card is not JSON" };
  }
  if (record(record(chat?.thread)?.lineage) !== null) return { kind: "current" };
  if (chat === null || !isPreV2Card(chat)) {
    return { kind: "skipped", reason: "the card is not a pre-V2 chat card" };
  }
  const converted = v2Thread(chat.thread);
  if (converted === null) {
    return { kind: "skipped", reason: "the card's thread names no provider instance" };
  }
  return { kind: "converted", chatJson: JSON.stringify({ ...chat, thread: converted }) };
}

/**
 * The host keeps each cloud box's chat card so a paused box lists without waking. Cards read from
 * pre-V2 boxes hold V1 thread shells, which no longer decode; rewrite them as V2 shells so every
 * card still lists after the upgrade.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly lease_id: string;
    readonly chat_json: string;
  }>`SELECT lease_id, chat_json FROM provisioned_chats`;
  for (const row of rows) {
    const rewrite = v2Chat(row.chat_json);
    if (rewrite.kind === "skipped") {
      yield* Effect.logWarning("A cloud chat card was not converted to V2 and will not list", {
        leaseId: row.lease_id,
        reason: rewrite.reason,
      });
    }
    if (rewrite.kind !== "converted") continue;
    yield* sql`UPDATE provisioned_chats SET chat_json = ${rewrite.chatJson} WHERE lease_id = ${row.lease_id}`;
  }
});
