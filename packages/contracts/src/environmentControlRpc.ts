/**
 * The environment-control WebSocket methods: cloud boxes a host provisions,
 * attaches, pauses, removes, and restores. `rpc.ts` spreads these into `WS_METHODS`
 * and `WsRpcGroup`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { EnvironmentId, NonNegativeInt } from "./baseSchemas.ts";
import {
  EnvironmentControlError,
  EnvironmentControlInput,
  EnvironmentControlList,
  ProvisionedEnvironmentList,
  SavedEnvironmentAddress,
  EnvironmentControlResult,
  EnvironmentControlPresenceInput,
  EnvironmentControlPresenceResult,
  EnvironmentProvisionInput,
  EnvironmentProvisionResult,
  EnvironmentProvisionAttachInput,
  EnvironmentProvisionAttachResult,
  EnvironmentProvisionDisposeInput,
  EnvironmentProvisionDisposeResult,
  EnvironmentProvisionPauseInput,
  EnvironmentProvisionPauseResult,
  EnvironmentProvisionResumeInput,
  EnvironmentProvisionResumeResult,
  EnvironmentProvisionUpgradeInput,
  EnvironmentProvisionUpgradeResult,
  EnvironmentProvisionSwitchAccountInput,
  EnvironmentProvisionSwitchAccountResult,
  EnvironmentProvisionClaimInput,
  EnvironmentProvisionClaimResult,
  EnvironmentProvisionTouchInput,
  EnvironmentProvisionTouchResult,
  EnvironmentProvisionKeepInput,
  EnvironmentProvisionKeepResult,
  EnvironmentProvisionRestoreInput,
  EnvironmentProvisionRestoreResult,
} from "./environmentControl.ts";

export const ENVIRONMENT_CONTROL_WS_METHODS = {
  environmentControlList: "environmentControl.list",
  environmentControlListProvisioned: "environmentControl.listProvisioned",
  environmentControlStart: "environmentControl.start",
  environmentControlStop: "environmentControl.stop",
  environmentControlProvision: "environmentControl.provision",
  environmentControlAttach: "environmentControl.attach",
  environmentControlDispose: "environmentControl.dispose",
  environmentControlPause: "environmentControl.pause",
  environmentControlResume: "environmentControl.resume",
  environmentControlUpgrade: "environmentControl.upgrade",
  environmentControlSwitchAccount: "environmentControl.switchAccount",
  environmentControlClaim: "environmentControl.claim",
  environmentControlTouch: "environmentControl.touch",
  environmentControlKeep: "environmentControl.keep",
  environmentControlRestore: "environmentControl.restore",
  environmentControlPresence: "environmentControl.presence",
} as const;

const EnvironmentControlListRpc = Rpc.make(ENVIRONMENT_CONTROL_WS_METHODS.environmentControlList, {
  payload: Schema.Struct({}),
  success: EnvironmentControlList,
  error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
});
const EnvironmentControlListProvisionedRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlListProvisioned,
  {
    payload: Schema.Struct({
      /**
       * The environments the client has saved. The host also returns those of them that were
       * its boxes and are gone, with lifecycle `disposed`.
       */
      environmentIds: Schema.optional(Schema.Array(EnvironmentId)),
      /**
       * Where the client dials those environments. A box disposed before the host kept its id
       * is named gone by its address instead.
       */
      addresses: Schema.optional(Schema.Array(SavedEnvironmentAddress)),
      /**
       * Asks for each box's chat. The host leaves out a chat the client already holds at this
       * sequence or a newer one.
       */
      chats: Schema.optional(
        Schema.Array(Schema.Struct({ environmentId: EnvironmentId, sequence: NonNegativeInt })),
      ),
    }),
    success: ProvisionedEnvironmentList,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlStartRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlStart,
  {
    payload: EnvironmentControlInput,
    success: EnvironmentControlResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlStopRpc = Rpc.make(ENVIRONMENT_CONTROL_WS_METHODS.environmentControlStop, {
  payload: EnvironmentControlInput,
  success: EnvironmentControlResult,
  error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
});

const EnvironmentControlProvisionRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlProvision,
  {
    payload: EnvironmentProvisionInput,
    success: EnvironmentProvisionResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlDisposeRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlDispose,
  {
    payload: EnvironmentProvisionDisposeInput,
    success: EnvironmentProvisionDisposeResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlPauseRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlPause,
  {
    payload: EnvironmentProvisionPauseInput,
    success: EnvironmentProvisionPauseResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlAttachRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlAttach,
  {
    payload: EnvironmentProvisionAttachInput,
    success: EnvironmentProvisionAttachResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlClaimRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlClaim,
  {
    payload: EnvironmentProvisionClaimInput,
    success: EnvironmentProvisionClaimResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlResumeRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlResume,
  {
    payload: EnvironmentProvisionResumeInput,
    success: EnvironmentProvisionResumeResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlUpgradeRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlUpgrade,
  {
    payload: EnvironmentProvisionUpgradeInput,
    success: EnvironmentProvisionUpgradeResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlSwitchAccountRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlSwitchAccount,
  {
    payload: EnvironmentProvisionSwitchAccountInput,
    success: EnvironmentProvisionSwitchAccountResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlTouchRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlTouch,
  {
    payload: EnvironmentProvisionTouchInput,
    success: EnvironmentProvisionTouchResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);
const EnvironmentControlKeepRpc = Rpc.make(ENVIRONMENT_CONTROL_WS_METHODS.environmentControlKeep, {
  payload: EnvironmentProvisionKeepInput,
  success: EnvironmentProvisionKeepResult,
  error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
});
const EnvironmentControlRestoreRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlRestore,
  {
    payload: EnvironmentProvisionRestoreInput,
    success: EnvironmentProvisionRestoreResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);

const EnvironmentControlPresenceRpc = Rpc.make(
  ENVIRONMENT_CONTROL_WS_METHODS.environmentControlPresence,
  {
    payload: EnvironmentControlPresenceInput,
    success: EnvironmentControlPresenceResult,
    error: Schema.Union([EnvironmentAuthorizationError, EnvironmentControlError]),
  },
);

export const EnvironmentControlRpcs = [
  EnvironmentControlListRpc,
  EnvironmentControlListProvisionedRpc,
  EnvironmentControlStartRpc,
  EnvironmentControlStopRpc,
  EnvironmentControlProvisionRpc,
  EnvironmentControlAttachRpc,
  EnvironmentControlDisposeRpc,
  EnvironmentControlPauseRpc,
  EnvironmentControlResumeRpc,
  EnvironmentControlUpgradeRpc,
  EnvironmentControlSwitchAccountRpc,
  EnvironmentControlClaimRpc,
  EnvironmentControlTouchRpc,
  EnvironmentControlKeepRpc,
  EnvironmentControlRestoreRpc,
  EnvironmentControlPresenceRpc,
] as const;
