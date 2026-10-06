import {
  type EnvironmentAuthorizationError,
  type EnvironmentControlRpcs,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as RpcGroup from "effect/rpc/RpcGroup";

import type { EnvironmentControl } from "./EnvironmentControl.ts";

type ObserveRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;

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
export const environmentControlWsHandlers = (
  environmentControl: EnvironmentControl["Service"],
  observeRpcEffect: ObserveRpcEffect,
) =>
  // `satisfies`, not a return annotation: `HandlersFrom` types each handler's requirements as
  // `any`, which spreads into the server's whole RPC layer.
  ({
    [WS_METHODS.environmentControlListProvisioned]: (input) =>
      observeRpcEffect(
        WS_METHODS.environmentControlListProvisioned,
        environmentControl.listProvisioned(input.environmentIds, input.addresses, input.chats),
      ),
    [WS_METHODS.environmentControlList]: () =>
      observeRpcEffect(WS_METHODS.environmentControlList, environmentControl.list),
    [WS_METHODS.environmentControlStart]: (input) =>
      observeRpcEffect(
        WS_METHODS.environmentControlStart,
        environmentControl.start(input.environmentId),
      ),
    [WS_METHODS.environmentControlStop]: (input) =>
      observeRpcEffect(
        WS_METHODS.environmentControlStop,
        environmentControl.stop(input.environmentId),
      ),
    [WS_METHODS.environmentControlProvision]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlProvision, environmentControl.provision(input)),
    [WS_METHODS.environmentControlDispose]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlDispose, environmentControl.dispose(input)),
    [WS_METHODS.environmentControlPause]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlPause, environmentControl.pause(input)),
    [WS_METHODS.environmentControlResume]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlResume, environmentControl.resume(input)),
    [WS_METHODS.environmentControlUpgrade]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlUpgrade, environmentControl.upgrade(input)),
    [WS_METHODS.environmentControlSwitchAccount]: (input) =>
      observeRpcEffect(
        WS_METHODS.environmentControlSwitchAccount,
        environmentControl.switchAccount(input),
      ),
    [WS_METHODS.environmentControlAttach]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlAttach, environmentControl.attach(input)),
    [WS_METHODS.environmentControlClaim]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlClaim, environmentControl.claim(input)),
    [WS_METHODS.environmentControlTouch]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlTouch, environmentControl.touch(input)),
    [WS_METHODS.environmentControlKeep]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlKeep, environmentControl.keep(input)),
    [WS_METHODS.environmentControlRestore]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlRestore, environmentControl.restore(input)),
    [WS_METHODS.environmentControlPresence]: (input) =>
      observeRpcEffect(WS_METHODS.environmentControlPresence, environmentControl.presence(input)),
  }) satisfies RpcGroup.HandlersFrom<(typeof EnvironmentControlRpcs)[number]>;
