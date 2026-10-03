// @effect-diagnostics globalFetch:off - the manager calls a remote T3 server over private HTTP.
import {
  CommandId,
  OrchestrationV2ThreadLaunchInput,
  type ProvisionFirstTurn,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { boxOrchestrationHeaders } from "./leaseActivity.ts";
import type { RemoteAccess } from "./ProvisionedLeaseRegistry.ts";

/** `pending` is worth retrying; `refused` means the box turned the turn away for good. */
export type FirstTurnDelivery = "delivered" | "pending" | "refused";

const encodeLaunch = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadLaunchInput));
const decodeThread = Schema.decodeUnknownExit(
  Schema.Struct({
    projection: Schema.Struct({
      messages: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  }),
);
const decodeShell = Schema.decodeUnknownExit(
  Schema.Struct({
    projects: Schema.Array(Schema.Struct({ id: ProjectId, workspaceRoot: Schema.String })),
    threads: Schema.Array(Schema.Struct({ id: ThreadId })),
  }),
);

const classify = (status: number): FirstTurnDelivery =>
  status >= 400 && status < 500 && status !== 408 && status !== 429 ? "refused" : "pending";

/**
 * Starts a chat's first turn on its box, at most once. One launch creates the thread and sends its
 * first message under a fixed command id: the box keeps a receipt per command, so a retry after any
 * crash replays the earlier launch instead of starting a second turn.
 */
export async function deliverFirstTurn(
  remote: RemoteAccess,
  chat: {
    readonly requestId: string;
    readonly threadId: string;
    readonly projectDir: string;
    readonly turn: ProvisionFirstTurn;
  },
): Promise<FirstTurnDelivery> {
  const headers = boxOrchestrationHeaders(remote);
  const shellResponse = await fetch(`${remote.origin}/api/orchestration/shell`, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!shellResponse.ok) {
    await shellResponse.body?.cancel();
    return "pending";
  }
  const shell = decodeShell(await shellResponse.json());
  if (shell._tag === "Failure") return "pending";
  const { turn } = chat;
  const threadId = ThreadId.make(chat.threadId);
  if (shell.value.threads.some((thread) => thread.id === threadId)) {
    // A page that sent the same message first, such as an older tab, already started it.
    const detail = await fetch(
      `${remote.origin}/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      { headers, redirect: "error", signal: AbortSignal.timeout(15_000) },
    );
    if (!detail.ok) {
      await detail.body?.cancel();
      return "pending";
    }
    const thread = decodeThread(await detail.json());
    if (thread._tag === "Failure") return "pending";
    if (thread.value.projection.messages.some((message) => message.id === turn.messageId))
      return "delivered";
  }
  const projects = shell.value.projects;
  const project =
    projects.find((candidate) => candidate.workspaceRoot === chat.projectDir) ??
    (projects.length === 1 ? projects[0] : undefined);
  if (!project) return "pending";
  const response = await fetch(`${remote.origin}/api/orchestration/launch-thread`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(
      encodeLaunch({
        commandId: CommandId.make(`first-turn:${chat.requestId}`),
        creationSource: "server",
        threadId,
        projectId: project.id,
        title: turn.title,
        ...(turn.titleSeed ? { generateTitle: true } : {}),
        modelSelection: turn.modelSelection,
        runtimeMode: turn.runtimeMode,
        interactionMode: turn.interactionMode,
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: turn.messageId, text: turn.text, attachments: [] },
      }),
    ),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  return response.ok ? "delivered" : classify(response.status);
}
