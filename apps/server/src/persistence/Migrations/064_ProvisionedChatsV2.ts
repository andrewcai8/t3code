import { ProvisionedChat } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeV2Chat = Schema.decodeUnknownExit(Schema.toCodecJson(ProvisionedChat));
const isV2Chat = (chat: unknown) => Exit.isSuccess(decodeV2Chat(chat));

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

function v2Chat(chatJson: string): string | null {
  let chat: Json | null;
  try {
    chat = record(JSON.parse(chatJson));
  } catch {
    return null;
  }
  if (chat === null || isV2Chat(chat)) return null;
  const thread = record(chat.thread);
  const converted = thread === null ? null : v2Thread(thread);
  if (converted === null) return null;
  const next = { ...chat, thread: converted };
  return isV2Chat(next) ? JSON.stringify(next) : null;
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
    const converted = v2Chat(row.chat_json);
    if (converted === null) continue;
    yield* sql`UPDATE provisioned_chats SET chat_json = ${converted} WHERE lease_id = ${row.lease_id}`;
  }
});
