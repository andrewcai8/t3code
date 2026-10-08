import { type EnvironmentControlRpcs, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type { EnvironmentControl } from "./EnvironmentControl.ts";

/** What `server.getConfig` tells clients about this host's cloud machines. */
export const environmentControlServerConfig = (
  environmentControl: EnvironmentControl["Service"],
  localAgentRuns: boolean,
) =>
  Effect.gen(function* () {
    const provisionedSkills = yield* environmentControl.provisionedSkills;
    return {
      environmentControl: true,
      localAgentRuns,
      // A config this server cannot read offers nothing rather than failing getConfig.
      provisionProviders: yield* environmentControl.provisionProviders.pipe(
        Effect.orElseSucceed(() => []),
      ),
      ...(provisionedSkills ? { provisionedSkills } : {}),
    };
  });

/** The WebSocket handlers for the environment-control RPCs, spread into the server's group. */
export const environmentControlWsHandlers = (environmentControl: EnvironmentControl["Service"]) =>
  // `satisfies`, not a return annotation: `HandlersFrom` types each handler's requirements as
  // `any`, which spreads into the server's whole RPC layer.
  ({
    [WS_METHODS.environmentControlListProvisioned]: (input) =>
      environmentControl.listProvisioned(input.environmentIds, input.addresses, input.chats),
    [WS_METHODS.environmentControlList]: () => environmentControl.list,
    [WS_METHODS.environmentControlStart]: (input) => environmentControl.start(input.environmentId),
    [WS_METHODS.environmentControlStop]: (input) => environmentControl.stop(input.environmentId),
    [WS_METHODS.environmentControlProvision]: (input) => environmentControl.provision(input),
    [WS_METHODS.environmentControlDispose]: (input) => environmentControl.dispose(input),
    [WS_METHODS.environmentControlPause]: (input) => environmentControl.pause(input),
    [WS_METHODS.environmentControlResume]: (input) => environmentControl.resume(input),
    [WS_METHODS.environmentControlUpgrade]: (input) => environmentControl.upgrade(input),
    [WS_METHODS.environmentControlSwitchAccount]: (input) =>
      environmentControl.switchAccount(input),
    [WS_METHODS.environmentControlAttach]: (input) => environmentControl.attach(input),
    [WS_METHODS.environmentControlClaim]: (input) => environmentControl.claim(input),
    [WS_METHODS.environmentControlTouch]: (input) => environmentControl.touch(input),
    [WS_METHODS.environmentControlKeep]: (input) => environmentControl.keep(input),
    [WS_METHODS.environmentControlRestore]: (input) => environmentControl.restore(input),
    [WS_METHODS.environmentControlPresence]: (input) => environmentControl.presence(input),
  }) satisfies RpcGroup.HandlersFrom<(typeof EnvironmentControlRpcs)[number]>;
