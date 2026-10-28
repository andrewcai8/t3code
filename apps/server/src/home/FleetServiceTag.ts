import type { FleetInvokeInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * Apart from FleetService.ts, whose helpers come from OrchestratorMcpService: MCP tool definitions
 * name this tag when they load, and that module reaches them back through RemoteDelegation.
 */
export class FleetService extends Context.Service<
  FleetService,
  {
    /** Runs one operation and returns its result, typed by `FleetResults[op]`. */
    readonly execute: (input: FleetInvokeInput) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  }
>()("t3/home/FleetServiceTag/FleetService") {}
