import {
  EnvironmentId,
  FleetEnvironmentChat,
  FleetForkBatch,
  FleetForkRunInput,
  FleetForkStatusInput,
  HomeWatch,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { homeRoutingDependencies } from "../../homeRouting.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    ...homeRoutingDependencies,
  ],
};

const EnvironmentListTool = Tool.make("t3_environment_list", {
  ...shared,
  description:
    "List the environments this thread can act in. Other threads see only their own environment. Home sees every environment the user's desktop app is connected to; relayConnected is false when no desktop window is open to relay calls to them. A top-level chat on a cloud machine sees the user's other cloud chats, each its own environment with its chat's last known title and status (listing never wakes a sleeping one; acting on it does), plus one environment that starts a new chat: t3_thread_launch there with a title and message starts a cloud chat on a fresh machine like this one. Another cloud chat can reply with t3_thread_send to this chat's environment and threadId.",
  success: Schema.Struct({
    currentEnvironmentId: EnvironmentId,
    relayConnected: Schema.Boolean,
    environments: Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        label: Schema.String,
        connected: Schema.Boolean,
        current: Schema.Boolean,
        chat: Schema.optional(FleetEnvironmentChat),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadWatchTool = Tool.make("t3_thread_watch", {
  ...shared,
  description:
    "Home only. Choose which threads wake Home. watch/unwatch one thread (threadId, optional environmentId), or watch_all/unwatch_all for every thread in every environment. Threads Home launches are already watched. A watch ends when its thread is settled or archived. Returns what Home now watches.",
  parameters: Schema.Struct({
    action: Schema.Literals(["watch", "unwatch", "watch_all", "unwatch_all"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ watchAll: Schema.Boolean, watches: Schema.Array(HomeWatch) }),
}).annotate(Tool.Destructive, false);

const ForkRunTool = Tool.make("t3_fork_run", {
  ...shared,
  description:
    "Top-level chats on a cloud sandbox machine only. Runs each job in its own throwaway copy of this machine as it is now: every file, install and build is there, but the T3 server and agents are stopped, so only the job runs. Use it for parallel or disk- and CPU-heavy work (eval replays, test shards, separate builds) instead of worktrees and installs on this machine. Nothing a job changes comes back except its logs and outputs: each job's stdout/stderr tails are returned, its full stdout.log and stderr.log are uploaded under logsUri, and each listed output is uploaded to outputsUri plus its path as given (an absolute path without its leading slash), so outputs:[out/report.json] is read with aws s3 cp <outputsUri>out/report.json. Pass copyBack:true to also copy outputs into this machine, under the folder each job's copiedTo names. It answers at once with a batchId and its jobs' states (all queued for a new batch), then starts it: the jobs run after the answer, so always follow with t3_fork_status (with waitSeconds) until state is finished. Starting briefly pauses this machine; a call made during the pause waits for it. Retrying the same call while its batch runs returns the same batch. A chat can run up to 4 batches at once, so a short job need not wait for a long batch; all of a chat's batches share its limit on copies running at once.",
  parameters: FleetForkRunInput,
  success: FleetForkBatch,
}).annotate(Tool.Destructive, false);

const ForkStatusTool = Tool.make("t3_fork_status", {
  ...shared,
  description:
    "Reports a t3_fork_run batch: each job's state, exit code, log tails and outputs. Pass waitSeconds to wait for the batch to finish first; call it again until state is finished.",
  parameters: FleetForkStatusInput,
  success: FleetForkBatch,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const HomeToolkit = Toolkit.make(
  EnvironmentListTool,
  ThreadWatchTool,
  ForkRunTool,
  ForkStatusTool,
);
