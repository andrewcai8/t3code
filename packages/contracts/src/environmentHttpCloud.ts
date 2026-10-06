/**
 * The cloud HTTP groups: a host's cloud boxes, starting a chat on one of them, and usage history.
 * `environmentHttp.ts` adds them to `EnvironmentHttpApi`, passing in its shared headers, errors
 * and auth so this module does not import it back.
 */
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";

import { ThreadId } from "./baseSchemas.ts";
import {
  EnvironmentProvisionAttachInput,
  EnvironmentProvisionAttachResult,
  EnvironmentProvisionClaimInput,
  EnvironmentProvisionClaimResult,
  EnvironmentProvisionDisposeInput,
  EnvironmentProvisionDisposeResult,
  EnvironmentProvisionInput,
  EnvironmentProvisionResult,
  EnvironmentProvisionTouchInput,
  EnvironmentProvisionTouchResult,
  ProvisionedEnvironmentList,
} from "./environmentControl.ts";
import type {
  EnvironmentAuthenticatedAuth,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
import { OrchestrationV2ThreadLaunchInput } from "./orchestrationV2.ts";
import { UsageSummary } from "./usage.ts";
import { UsageHistoryInput, UsageImportInput, UsageImportResult } from "./usageHistory.ts";

/**
 * What a host learns from starting a chat on one of its cloud boxes. The box replays a repeated
 * `commandId`, so `resumed` is true when an earlier attempt already launched the thread.
 */
export const EnvironmentOrchestrationLaunchThreadResult = Schema.Struct({
  threadId: ThreadId,
  resumed: Schema.Boolean,
});
export type EnvironmentOrchestrationLaunchThreadResult =
  typeof EnvironmentOrchestrationLaunchThreadResult.Type;

export function makeEnvironmentCloudHttpApis<
  BearerHeaders extends Schema.Top,
  ProtocolHeaders extends Schema.Top,
>(shared: {
  readonly bearerHeaders: BearerHeaders;
  readonly protocolHeaders: ProtocolHeaders;
  readonly auth: typeof EnvironmentAuthenticatedAuth;
  readonly requestInvalid: typeof EnvironmentRequestInvalidError;
  readonly scopeRequired: typeof EnvironmentScopeRequiredError;
  readonly internal: typeof EnvironmentInternalError;
}) {
  const scopedErrors = [shared.scopeRequired, shared.internal] as const;
  const launchErrors = [shared.requestInvalid, shared.scopeRequired, shared.internal] as const;

  const EnvironmentControlHttpApi = HttpApiGroup.make("environmentControl")
    .add(
      HttpApiEndpoint.post("listProvisioned", "/api/environment-control/list-provisioned", {
        headers: shared.bearerHeaders,
        payload: Schema.Struct({}),
        success: ProvisionedEnvironmentList,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("provision", "/api/environment-control/provision", {
        headers: shared.bearerHeaders,
        payload: EnvironmentProvisionInput,
        success: EnvironmentProvisionResult,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("attach", "/api/environment-control/attach", {
        headers: shared.bearerHeaders,
        payload: EnvironmentProvisionAttachInput,
        success: EnvironmentProvisionAttachResult,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("claim", "/api/environment-control/claim", {
        headers: shared.bearerHeaders,
        payload: EnvironmentProvisionClaimInput,
        success: EnvironmentProvisionClaimResult,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("touch", "/api/environment-control/touch", {
        headers: shared.bearerHeaders,
        payload: EnvironmentProvisionTouchInput,
        success: EnvironmentProvisionTouchResult,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("dispose", "/api/environment-control/dispose", {
        headers: shared.bearerHeaders,
        payload: EnvironmentProvisionDisposeInput,
        success: EnvironmentProvisionDisposeResult,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("launchThread", "/api/orchestration/launch-thread", {
        headers: shared.protocolHeaders,
        payload: OrchestrationV2ThreadLaunchInput,
        success: EnvironmentOrchestrationLaunchThreadResult,
        error: launchErrors,
      }).middleware(shared.auth),
    );

  /**
   * A host pulls each cloud box's usage history with the box's broker token, and a machine no
   * client connects to pushes its own.
   */
  const EnvironmentUsageHttpApi = HttpApiGroup.make("usage")
    .add(
      HttpApiEndpoint.post("history", "/api/usage/history", {
        headers: shared.bearerHeaders,
        payload: UsageHistoryInput,
        success: UsageSummary,
        error: scopedErrors,
      }).middleware(shared.auth),
    )
    .add(
      HttpApiEndpoint.post("import", "/api/usage/import", {
        headers: shared.bearerHeaders,
        payload: UsageImportInput,
        success: UsageImportResult,
        error: scopedErrors,
      }).middleware(shared.auth),
    );

  return { EnvironmentControlHttpApi, EnvironmentUsageHttpApi };
}
