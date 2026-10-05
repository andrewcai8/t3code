import { DiscoveredProvisionedEnvironment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { presentProvisionedEnvironment } from "./provisionedEnvironmentRowModel";

const machine = Schema.decodeUnknownSync(DiscoveredProvisionedEnvironment)({
  requestId: "11111111-1111-4111-a111-111111111111",
  leaseId: "11111111-1111-4111-a111-111111111112",
  sandboxId: "sandbox-1",
  lifecycle: "paused",
  environmentId: "box-1",
  provider: "e2b",
  label: "proof/repo",
  repository: "proof/repo",
  projectDir: "/home/user/proof",
  threadId: "existing-thread",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2100-01-01T00:00:00.000Z",
});

const now = Date.parse("2026-03-01T12:00:00.000Z");

describe("presentProvisionedEnvironment", () => {
  it("names a machine for its chat and shows what its host says of it", () => {
    expect(
      presentProvisionedEnvironment({
        environment: machine,
        threadTitle: "Fix the login flow",
        action: { kind: "idle" },
        now,
      }),
    ).toEqual({
      title: "Fix the login flow",
      detail: "E2B · proof/repo",
      status: "Paused",
      tone: "muted",
      cleanupAction: null,
      restorable: false,
    });
  });

  it("falls back to the host's label for a chat that is not on this device", () => {
    expect(
      presentProvisionedEnvironment({
        environment: machine,
        threadTitle: null,
        action: { kind: "working", label: "Resuming…" },
        now,
      }),
    ).toMatchObject({ title: "proof/repo", status: "Resuming…" });
  });

  it("shows a failed action as the status", () => {
    expect(
      presentProvisionedEnvironment({
        environment: machine,
        threadTitle: null,
        action: { kind: "failed", message: "The host could not delete this machine." },
        now,
      }),
    ).toMatchObject({ status: "The host could not delete this machine.", tone: "danger" });
  });

  it("shows when a paused machine will be removed and offers to keep it", () => {
    expect(
      presentProvisionedEnvironment({
        environment: {
          ...machine,
          cleanup: { kind: "scheduled", at: "2026-03-01T12:40:00.000Z", reason: "settled" },
        },
        threadTitle: null,
        action: { kind: "idle" },
        now,
      }),
    ).toMatchObject({ status: "Paused · Settled · Removed in 40 min", cleanupAction: "keep" });
  });

  it("offers to allow cleanup of a machine the user kept, but not of one kept for its work", () => {
    const present = (reason: "user" | "unsaved-work") =>
      presentProvisionedEnvironment({
        environment: { ...machine, cleanup: { kind: "kept", reason } },
        threadTitle: null,
        action: { kind: "idle" },
        now,
      });
    expect([present("user"), present("unsaved-work")]).toMatchObject([
      { status: "Paused · Kept", cleanupAction: "allow" },
      { status: "Paused · Kept · work could not be backed up", cleanupAction: null },
    ]);
  });

  it("shows until when a deleted machine can be restored, and offers it only until then", () => {
    const deleted = (restorableUntil: string) =>
      presentProvisionedEnvironment({
        environment: { ...machine, lifecycle: "disposed", restorableUntil },
        threadTitle: null,
        action: { kind: "idle" },
        now,
      });
    expect(deleted("2026-03-31T12:00:00.000Z")).toMatchObject({
      status: "Deleted · Restorable until Mar 31",
      restorable: true,
    });
    expect(deleted("2026-03-01T11:00:00.000Z")).toMatchObject({
      status: "Deleted",
      restorable: false,
    });
  });
});
