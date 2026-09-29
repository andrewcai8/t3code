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

describe("presentProvisionedEnvironment", () => {
  it("names a machine for its chat and shows what its host says of it", () => {
    expect(
      presentProvisionedEnvironment({
        environment: machine,
        threadTitle: "Fix the login flow",
        action: { kind: "idle" },
      }),
    ).toEqual({
      title: "Fix the login flow",
      detail: "E2B · proof/repo",
      status: "Paused",
      tone: "muted",
    });
  });

  it("falls back to the host's label for a chat that is not on this device", () => {
    expect(
      presentProvisionedEnvironment({
        environment: machine,
        threadTitle: null,
        action: { kind: "working", label: "Resuming…" },
      }),
    ).toMatchObject({ title: "proof/repo", status: "Resuming…" });
  });

  it("shows a failed action as the status", () => {
    expect(
      presentProvisionedEnvironment({
        environment: machine,
        threadTitle: null,
        action: { kind: "failed", message: "The host could not delete this machine." },
      }),
    ).toMatchObject({ status: "The host could not delete this machine.", tone: "danger" });
  });
});
