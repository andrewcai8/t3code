// @effect-diagnostics globalDate:off - read times are ISO timestamps at the server boundary.
/**
 * The host's last read of each cloud box's chat: the lease owner's thread and its project, taken
 * from the box's own shell. A client lists the chat from it without reaching the box, so a paused
 * box stays paused. Kept apart from `lease_json`, which lease transitions rewrite.
 *
 * @module provisionedChats
 */
import {
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProvisionedChat,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeShellEntries = Schema.decodeUnknownExit(
  Schema.Struct({
    snapshotSequence: ProvisionedChat.fields.sequence,
    projects: Schema.Array(Schema.Unknown),
    threads: Schema.Array(Schema.Unknown),
  }),
);
const decodeThread = Schema.decodeUnknownExit(OrchestrationThreadShell);
const decodeProject = Schema.decodeUnknownExit(OrchestrationProjectShell);
const encodeChat = Schema.encodeSync(Schema.fromJsonString(ProvisionedChat));
const decodeChat = Schema.decodeUnknownExit(Schema.fromJsonString(ProvisionedChat));

const hasId = (id: string) => (entry: unknown) =>
  typeof entry === "object" && entry !== null && "id" in entry && entry.id === id;

/**
 * The owner's chat in a box's shell body. Null when the shell holds no such thread, as before the
 * chat's first turn. Undefined when the body does not decode, as from a box on an older revision,
 * so the host keeps what it read before. Other threads are not decoded, so their shape never
 * matters.
 */
export function ownerChat(
  body: unknown,
  ownerThreadId: string,
): ProvisionedChat | null | undefined {
  const shell = decodeShellEntries(body);
  if (shell._tag === "Failure") return undefined;
  const threadBody = shell.value.threads.find(hasId(ownerThreadId));
  if (threadBody === undefined) return null;
  const thread = decodeThread(threadBody);
  if (thread._tag === "Failure") return undefined;
  const project = decodeProject(shell.value.projects.find(hasId(thread.value.projectId)));
  if (project._tag === "Failure") return undefined;
  return { sequence: shell.value.snapshotSequence, project: project.value, thread: thread.value };
}

export interface ProvisionedChatStore {
  /**
   * Keeps a box's chat unless the host already holds that thread at this sequence or a newer one.
   * A claim can hand the box to another thread at the same sequence.
   */
  readonly record: (leaseId: string, chat: ProvisionedChat, now?: Date) => Promise<void>;
  /** The thread of the chat the host holds for each lease. */
  readonly heldThreads: () => Promise<ReadonlyMap<string, string>>;
  /** The chat the host holds for a lease; null when none, or one that no longer decodes. */
  readonly read: (leaseId: string) => Promise<ProvisionedChat | null>;
}

export function createProvisionedChatStore(sql: SqlClient.SqlClient): ProvisionedChatStore {
  return {
    record: async (leaseId, chat, now = new Date()) => {
      await Effect.runPromise(sql`
        INSERT INTO provisioned_chats (lease_id, sequence, chat_json, read_at)
        VALUES (${leaseId}, ${chat.sequence}, ${encodeChat(chat)}, ${now.toISOString()})
        ON CONFLICT(lease_id) DO UPDATE SET
          sequence = excluded.sequence,
          chat_json = excluded.chat_json,
          read_at = excluded.read_at
        WHERE excluded.sequence > provisioned_chats.sequence
          OR (excluded.sequence = provisioned_chats.sequence
            AND json_extract(excluded.chat_json, '$.thread.id')
              IS NOT json_extract(provisioned_chats.chat_json, '$.thread.id'))
      `);
    },
    heldThreads: async () => {
      const rows = await Effect.runPromise(
        sql<{
          readonly lease_id: string;
          readonly thread_id: string;
        }>`SELECT lease_id, json_extract(chat_json, '$.thread.id') AS thread_id FROM provisioned_chats`,
      );
      return new Map(rows.map((row) => [row.lease_id, row.thread_id]));
    },
    read: async (leaseId) => {
      const rows = await Effect.runPromise(
        sql<{
          readonly chat_json: string;
        }>`SELECT chat_json FROM provisioned_chats WHERE lease_id = ${leaseId}`,
      );
      const chat = rows[0] === undefined ? null : decodeChat(rows[0].chat_json);
      return chat?._tag === "Success" ? chat.value : null;
    },
  };
}
