import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("environment control RPC scopes", () => {
  it("lets read-only clients list cloud machines but not run or change them", () => {
    const scopes = [
      WS_METHODS.environmentControlListProvisioned,
      WS_METHODS.environmentControlStart,
      WS_METHODS.environmentControlStop,
      WS_METHODS.environmentControlProvision,
      WS_METHODS.environmentControlDispose,
      WS_METHODS.environmentControlKeep,
    ].map(requiredScopeForRpcMethod);
    expect(scopes).toEqual([
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthOrchestrationOperateScope,
      AuthOrchestrationOperateScope,
      AuthOrchestrationOperateScope,
      AuthOrchestrationOperateScope,
    ]);
  });

  it("allows provisioned environment discovery with read scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.environmentControlListProvisioned)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("requires operate scope for provisioning, fresh attachment and lease cleanup", () => {
    for (const method of [
      WS_METHODS.environmentControlProvision,
      WS_METHODS.environmentControlAttach,
      WS_METHODS.environmentControlClaim,
      WS_METHODS.environmentControlTouch,
      WS_METHODS.environmentControlKeep,
      WS_METHODS.environmentControlDispose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });
});
