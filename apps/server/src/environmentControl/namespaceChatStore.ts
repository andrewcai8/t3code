// @effect-diagnostics nodeBuiltinImport:off - chat records live in the manager's private state directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Schema from "effect/Schema";
import { ChatRecord, type ChatStore, type Settled } from "./namespaceChat.ts";
import { writeReplace } from "./ProvisionPreparation.ts";

const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ChatRecord));
const encodeRecord = Schema.encodeSync(ChatRecord);
const SAFE_CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** One file per chat under `<stateDir>/namespace-chats`, replaced atomically. */
export function makeChatStore(stateDir: string): ChatStore {
  const directory = NodePath.join(stateDir, "namespace-chats");
  const path = (chatId: string) => {
    if (!SAFE_CHAT_ID.test(chatId))
      throw new Error(`Namespace chat id ${JSON.stringify(chatId)} is not a safe file name.`);
    return NodePath.join(directory, `${chatId}.json`);
  };
  const read = async (chatId: string) => {
    try {
      return decodeRecord(await NodeFSP.readFile(path(chatId), "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  };
  const write = async (chatId: string, settle: (current: ChatRecord | null) => Settled) => {
    const settled = settle(await read(chatId));
    if (!settled.ok) return settled;
    if (settled.record === null) await NodeFSP.rm(path(chatId), { force: true });
    else {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      await writeReplace(path(chatId), stableStringify(encodeRecord(settled.record)));
    }
    return settled;
  };
  const queues = new Map<string, Promise<unknown>>();
  return {
    read,
    update: (chatId, settle) => {
      const result = (queues.get(chatId) ?? Promise.resolve()).then(() => write(chatId, settle));
      const queued = result.catch(() => undefined);
      queues.set(chatId, queued);
      void queued.then(() => {
        if (queues.get(chatId) === queued) queues.delete(chatId);
      });
      return result;
    },
  };
}
