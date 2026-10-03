import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

export const LOCAL_AGENT_RUNS_DISABLED_MESSAGE =
  "This server does not run agents. Start the chat on a cloud environment.";

/** False on a cloud-only host (T3CODE_LOCAL_AGENT_RUNS=false). */
export const localAgentRunsEnabled = Effect.serviceOption(ServerConfig.ServerConfig).pipe(
  Effect.map(Option.match({ onNone: () => true, onSome: (config) => config.localAgentRuns })),
);

/**
 * A cloud-only host must never start a run here. Clients, scheduled tasks,
 * limit recovery and MCP tools all reach the orchestrator through
 * ThreadManagementService, so it refuses turns and answers with this.
 * ThreadLaunchService checks too, before it creates the thread.
 */
export const makeLocalRunRefusal = Effect.map(
  localAgentRunsEnabled,
  (localAgentRuns) =>
    (command: {
      readonly type: string;
      readonly commandId: OrchestrationV2ServerCommand["commandId"];
    }) =>
      !localAgentRuns &&
      (command.type === "message.dispatch" || command.type === "runtime-request.respond")
        ? Effect.fail(
            new Orchestrator.OrchestratorCommandRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              cause: new Error(LOCAL_AGENT_RUNS_DISABLED_MESSAGE),
            }),
          )
        : Effect.void,
);
