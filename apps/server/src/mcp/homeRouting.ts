import {
  type EnvironmentId,
  type FleetInput,
  type FleetOperation,
  type FleetRequest,
  type FleetResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as FleetBroker from "../home/FleetBroker.ts";
import * as FleetService from "../home/FleetService.ts";
import * as HomeService from "../home/HomeService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "./threadAccess.ts";

/** Services a tool needs to declare when it routes Home calls. */
export const homeRoutingDependencies = [
  HomeService.HomeService,
  FleetService.FleetService,
  FleetBroker.FleetBroker,
  ThreadManagement.ThreadManagementService,
] as const;

/**
 * Whether the calling thread is Home. Read on every call. A credential that
 * cannot control threads, or a client outside a thread, is never Home, so the
 * tool's own capability check still runs first.
 */
export const callerIsHome = Effect.fn("mcp.callerIsHome")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration") || scope.thread === undefined) return false;
  const home = yield* HomeService.HomeService;
  return yield* home.isHome(scope.thread.threadId);
});

/**
 * Whether the caller is a cloud chat whose host relays for it, and whether that host is connected
 * now. Where the desktop app does not host the server, the only fleet host ws.ts admits is the
 * cloud host that provisioned this box, and it reaches the user's other cloud chats. The box's
 * top-level chats act through it; subagents do not.
 */
const callerCloudReach = Effect.fn("mcp.callerCloudReach")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration") || scope.thread === undefined) return "none";
  if ((yield* HomeService.HomeService).available) return "none";
  const caller = yield* (yield* ThreadManagement.ThreadManagementService)
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (caller === null || caller.lineage.relationshipToParent === "subagent") return "none";
  return (yield* (yield* FleetBroker.FleetBroker).reach).hostConnected
    ? "connected"
    : "reconnecting";
});

const callerHasCloudReach = Effect.fn("mcp.callerHasCloudReach")(function* () {
  return (yield* callerCloudReach()) === "connected";
});

/** Whether the caller may act in other environments: Home, or a cloud chat its host relays for. */
export const callerHasFleetReach = Effect.fn("mcp.callerHasFleetReach")(function* () {
  return (yield* callerIsHome()) || (yield* callerHasCloudReach());
});

/**
 * The failure for a caller without fleet reach. A cloud chat whose host is between connections
 * is told to retry, so an agent does not conclude it lacks the capability.
 */
export const fleetReachDenial = Effect.fn("mcp.fleetReachDenial")(function* (message: string) {
  return (yield* callerCloudReach()) === "reconnecting"
    ? new OrchestratorMcpFailure({
        code: "environment_unavailable",
        message:
          "This cloud machine is reconnecting to its host. Retry in a minute; nothing about this call was refused.",
      })
    : new OrchestratorMcpFailure({ code: "capability_denied", message });
});

/**
 * Whether each operation needs the caller in full-access/default mode. A change does; reads, and
 * cancelling a fork job, which only stops work, do not. A new operation must pick a side.
 */
export const CHANGES_STATE = {
  capabilities: false,
  "projects.list": false,
  "threads.list": false,
  "threads.read": false,
  "requests.list": false,
  "requests.read": false,
  "threads.launch": true,
  "threads.send": true,
  "threads.interrupt": true,
  "threads.organize": true,
  "threads.rename": true,
  "requests.respond": true,
  "forks.run": true,
  "forks.status": false,
  "forks.cancel": false,
} satisfies Record<FleetOperation, boolean>;

/**
 * Reads the caller for a change Home makes. A change needs a live Home run in
 * full-access/default mode, so switching Home to plan or a narrower runtime
 * mode makes it read-only everywhere.
 */
export const readHomeChangeCaller = Effect.fn("mcp.readHomeChangeCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  yield* assertFullAccess(context, "Home makes changes only in full-access/default mode.");
  return context;
});

/** Runs a fleet operation as Home, here or in the environment it names. */
export const runAsHome = Effect.fn("mcp.runAsHome")(function* <Op extends FleetOperation>(
  environmentId: EnvironmentId | undefined,
  op: Op,
  input: FleetInput<Op>,
) {
  const { scope } = CHANGES_STATE[op] ? yield* readHomeChangeCaller() : yield* readCaller();
  // Checked again here, right before acting: Home may have been turned off or
  // started fresh while the tool did earlier work.
  if (scope.thread === undefined || !(yield* callerHasFleetReach())) {
    return yield* yield* fleetReachDenial("Only Home can act with the user's reach.");
  }
  const invoke = {
    actor: { environmentId: scope.environmentId, threadId: scope.thread.threadId },
    // The pairing of op and input is what FleetInput<Op> guarantees.
    request: { op, input } as FleetRequest,
  };
  const result =
    environmentId === undefined || environmentId === scope.environmentId
      ? yield* (yield* FleetService.FleetService).execute(invoke)
      : yield* (yield* FleetBroker.FleetBroker).invoke(environmentId, invoke);
  // Local results come from the typed handlers; remote ones are decoded per op.
  return result as FleetResult<Op>;
});

/**
 * Routes a tool call from Home to the environment it names, with Home's reach
 * over every project. A cloud chat its host relays for is routed only when it
 * names another environment. Returns None for any other call, which keeps its
 * calling-project reach.
 */
export const routeHome = Effect.fn("mcp.routeHome")(function* <Op extends FleetOperation>(
  environmentId: EnvironmentId | undefined,
  op: Op,
  input: FleetInput<Op>,
) {
  if (yield* callerIsHome()) {
    return Option.some(yield* runAsHome(environmentId, op, input));
  }
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (environmentId !== undefined && environmentId !== scope.environmentId) {
    if (yield* callerHasCloudReach())
      return Option.some(yield* runAsHome(environmentId, op, input));
    return yield* yield* fleetReachDenial("Only Home can act in another environment.");
  }
  return Option.none<FleetResult<Op>>();
});
