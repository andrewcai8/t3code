// @effect-diagnostics nodeBuiltinImport:off - chat records live in the manager's private state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { writeReplace } from "./ProvisionPreparation.ts";

/** A filesystem snapshot of a chat's box, which a fresh box boots from when its memory is gone. */
const ModalDiskSave = Schema.Struct({ imageId: Schema.String, at: Schema.Number });
export type ModalDiskSave = typeof ModalDiskSave.Type;

/**
 * Where a Modal chat is. `awake` runs on a sandbox; `saving` is written before that sandbox's
 * memory snapshot, which ends it, and `asleep` records the snapshot it wakes from. `stopped` kept
 * only its disk, so it wakes as a fresh boot. `chainStartedAt` is when the first snapshot this
 * chat's memory descends from was taken, since a restored box's snapshot expires with that one;
 * null on a box that was never snapshotted. `disk` is the chat's latest disk save, if any.
 */
export const ModalChatRecord = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["awake", "saving"]),
    sandboxId: Schema.String,
    startedAt: Schema.Number,
    chainStartedAt: Schema.NullOr(Schema.Number),
    disk: Schema.optional(ModalDiskSave),
  }),
  Schema.Struct({
    kind: Schema.Literal("asleep"),
    snapshotId: Schema.String,
    chainStartedAt: Schema.Number,
    disk: Schema.optional(ModalDiskSave),
  }),
  /** `reason` completes "booted fresh because ...", as the chat is told when it wakes. */
  Schema.Struct({ kind: Schema.Literal("stopped"), disk: ModalDiskSave, reason: Schema.String }),
]);
export type ModalChatRecord = typeof ModalChatRecord.Type;

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ModalChatRecord));
const encodeRecord = Schema.encodeSync(ModalChatRecord);
const SAFE_CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** One file per chat under `<stateDir>/modal-chats`, replaced atomically. */
export function makeModalChatStore(stateDir: string) {
  const directory = NodePath.join(stateDir, "modal-chats");
  const path = (chatId: string) => {
    if (!SAFE_CHAT_ID.test(chatId))
      throw new Error(`Modal chat id ${JSON.stringify(chatId)} is not a safe file name.`);
    return NodePath.join(directory, `${chatId}.json`);
  };
  return {
    read: async (chatId: string): Promise<ModalChatRecord | null> => {
      try {
        return decodeRecord(await NodeFSP.readFile(path(chatId), "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    },
    write: async (chatId: string, record: ModalChatRecord | null) => {
      if (record === null) return NodeFSP.rm(path(chatId), { force: true });
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeReplace(path(chatId), stableStringify(encodeRecord(record)));
    },
  };
}
