import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createProvisionedEnvironmentRecovery } from "./provisionedEnvironmentRecovery";
import {
  forgetProvisionedSandbox,
  provisionedSandboxForEnvironment,
  rememberProvisionedSandbox,
} from "./provisionedSandboxLeases";

const threadRef = { environmentId: EnvironmentId.make("child"), threadId: ThreadId.make("thread") };
const lease = {
  leaseId: "lease",
  sandboxId: "sandbox",
  managerEnvironmentId: EnvironmentId.make("manager"),
};
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
afterEach(() => {
  forgetProvisionedSandbox(threadRef);
  forgetProvisionedSandbox("draft");
});

describe("provisioned workspace recovery", () => {
  it("derives an owner-qualified lease from the thread without treating drafts as children", () => {
    rememberProvisionedSandbox("draft", lease);
    expect(provisionedSandboxForEnvironment(threadRef.environmentId)).toBeNull();
    rememberProvisionedSandbox(threadRef, lease);
    expect(provisionedSandboxForEnvironment(threadRef.environmentId)).toEqual({ lease, threadRef });
  });
  it("coalesces recovery and waits for the retained connection before the caller continues", async () => {
    rememberProvisionedSandbox(threadRef, lease);
    const ready = signal();
    const waiting = signal();
    const calls: string[] = [];
    const recover = createProvisionedEnvironmentRecovery({
      resume: async (owned) => {
        expect(owned).toEqual({ lease, threadRef });
        calls.push("resume");
      },
      retry: async (environmentId) => {
        expect(environmentId).toBe("child");
        calls.push("retry");
      },
      awaitConnected: async () => {
        calls.push("await-connected");
        waiting.resolve();
        await ready.promise;
      },
    });
    const recovered = recover(threadRef.environmentId);
    expect(recover(threadRef.environmentId)).toBe(recovered);
    const sent: string[] = [];
    const send = recovered.then((result) => {
      if (result.kind === "ready") sent.push("pending draft");
    });
    await waiting.promise;
    expect(calls).toEqual(["resume", "retry", "await-connected"]);
    expect(sent).toEqual([]);
    ready.resolve();
    await send;
    expect(sent).toEqual(["pending draft"]);
    expect(await recovered).toEqual({ kind: "ready" });
  });
  it("keeps ordinary retry independent of provisioning", async () => {
    const resume = vi.fn();
    const retry = vi.fn();
    const awaitConnected = vi.fn();
    expect(
      await createProvisionedEnvironmentRecovery({ resume, retry, awaitConnected })(
        threadRef.environmentId,
      ),
    ).toEqual({ kind: "not-provisioned" });
    expect(resume).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(awaitConnected).not.toHaveBeenCalled();
  });
  it("does not retry the child after refusal and allows another recovery attempt", async () => {
    rememberProvisionedSandbox(threadRef, lease);
    const retry = vi.fn();
    const recover = createProvisionedEnvironmentRecovery({
      resume: vi
        .fn()
        .mockRejectedValueOnce(new Error("Workspace unavailable"))
        .mockResolvedValue(undefined),
      retry,
      awaitConnected: async () => {},
    });
    expect(await recover(threadRef.environmentId)).toEqual({
      kind: "failed",
      message: "Workspace unavailable",
    });
    expect(retry).not.toHaveBeenCalled();
    expect(await recover(threadRef.environmentId)).toEqual({ kind: "ready" });
  });
  it("reports a connection deadline without continuing the original action", async () => {
    rememberProvisionedSandbox(threadRef, lease);
    const recover = createProvisionedEnvironmentRecovery({
      resume: async () => {},
      retry: async () => {},
      awaitConnected: async () => {
        throw new Error("Connection not ready");
      },
    });
    expect(await recover(threadRef.environmentId)).toEqual({
      kind: "failed",
      message: "Connection not ready",
    });
  });
});
