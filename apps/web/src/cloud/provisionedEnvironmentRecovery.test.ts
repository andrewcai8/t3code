import { EnvironmentId, type EnvironmentProvisionResumeResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { createProvisionedEnvironmentRecovery } from "./provisionedEnvironmentRecovery";

const child = EnvironmentId.make("child");
const manager = EnvironmentId.make("manager");
const notProvisioned: EnvironmentProvisionResumeResult = {
  kind: "refused",
  reason: "not-provisioned",
  message: "This machine has no workspace for that environment.",
};
function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
function operations(
  resume: (
    managerId: EnvironmentId,
    environmentId: EnvironmentId,
  ) => Promise<EnvironmentProvisionResumeResult | null>,
) {
  return {
    managers: () => [manager],
    resume,
    markMissing: vi.fn(async () => {}),
    retry: async () => {},
    awaitConnected: async () => {},
  };
}

describe("provisioned workspace recovery", () => {
  it("asks the manager to resume the environment without any local lease", async () => {
    const resumed: string[] = [];
    const recover = createProvisionedEnvironmentRecovery(
      operations(async (managerId, environmentId) => {
        resumed.push(`${managerId}/${environmentId}`);
        return { kind: "resumed" };
      }),
    );
    expect(await recover(child)).toEqual({ kind: "ready" });
    expect(resumed).toEqual(["manager/child"]);
  });
  it("coalesces recovery and waits for the retained connection before the caller continues", async () => {
    const ready = signal();
    const waiting = signal();
    const calls: string[] = [];
    const recover = createProvisionedEnvironmentRecovery({
      ...operations(async () => {
        calls.push("resume");
        return { kind: "resumed" };
      }),
      retry: async (environmentId) => {
        calls.push(`retry ${environmentId}`);
      },
      awaitConnected: async () => {
        calls.push("await-connected");
        waiting.resolve();
        await ready.promise;
      },
    });
    const recovered = recover(child);
    expect(recover(child)).toBe(recovered);
    const sent: string[] = [];
    const send = recovered.then((result) => {
      if (result.kind === "ready") sent.push("pending draft");
    });
    await waiting.promise;
    expect(calls).toEqual(["resume", "retry child", "await-connected"]);
    expect(sent).toEqual([]);
    ready.resolve();
    await send;
    expect(sent).toEqual(["pending draft"]);
    expect(await recovered).toEqual({ kind: "ready" });
  });
  it("leaves ordinary retry to the caller when no connected manager knows the environment", async () => {
    const retry = vi.fn();
    const recover = createProvisionedEnvironmentRecovery({
      ...operations(async () => notProvisioned),
      managers: () => [manager, EnvironmentId.make("unreachable")],
      resume: async (managerId) => (managerId === manager ? notProvisioned : null),
      retry,
    });
    expect(await recover(child)).toEqual({ kind: "not-provisioned" });
    expect(retry).not.toHaveBeenCalled();
  });
  it("marks a workspace the provider no longer has as missing", async () => {
    const recovery = operations(async () => ({
      kind: "refused",
      reason: "missing",
      message: "The cloud provider no longer has this workspace. It cannot be reconnected.",
    }));
    expect(await createProvisionedEnvironmentRecovery(recovery)(child)).toEqual({
      kind: "failed",
      message: "The cloud provider no longer has this workspace. It cannot be reconnected.",
    });
    expect(recovery.markMissing).toHaveBeenCalledWith(child);
  });
  it("does not retry the child after refusal and allows another recovery attempt", async () => {
    const retry = vi.fn();
    const resume = vi
      .fn<() => Promise<EnvironmentProvisionResumeResult>>()
      .mockResolvedValueOnce({
        kind: "refused",
        reason: "unknown",
        message: "Workspace unavailable",
      })
      .mockResolvedValue({ kind: "resumed" });
    const recover = createProvisionedEnvironmentRecovery({ ...operations(resume), retry });
    expect(await recover(child)).toEqual({ kind: "failed", message: "Workspace unavailable" });
    expect(retry).not.toHaveBeenCalled();
    expect(await recover(child)).toEqual({ kind: "ready" });
  });
  it("reports a connection deadline without continuing the original action", async () => {
    const recover = createProvisionedEnvironmentRecovery({
      ...operations(async () => ({ kind: "resumed" })),
      awaitConnected: async () => {
        throw new Error("Connection not ready");
      },
    });
    expect(await recover(child)).toEqual({ kind: "failed", message: "Connection not ready" });
  });
});
