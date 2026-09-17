// @effect-diagnostics nodeBuiltinImport:off - these tests serve a fake remote T3 over local HTTP.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { readLeaseActivity, shellActivity } from "./leaseActivity.ts";
import type { ProvisionedLease } from "./ProvisionedLeaseRegistry.ts";

const thread = (fields: Record<string, unknown>) => ({
  id: "thread",
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...fields,
});
const session = (status: string) => ({ threadId: "thread", status, activeTurnId: null });

describe("shellActivity", () => {
  it.each([
    ["a starting session", [thread({ session: session("starting") })], "busy"],
    ["a running session", [thread({ session: session("running") })], "busy"],
    ["a pending approval", [thread({ hasPendingApprovals: true })], "busy"],
    ["working background agents", [thread({ backgroundLiveness: "working" })], "busy"],
    [
      "one busy chat among idle ones",
      [thread({}), thread({ session: session("running") })],
      "busy",
    ],
    ["a ready session", [thread({ session: session("ready") })], "idle"],
    ["pending user input", [thread({ hasPendingUserInput: true })], "idle"],
    ["a monitoring watch loop", [thread({ backgroundLiveness: "monitoring" })], "idle"],
    [
      "an archived running chat",
      [thread({ archivedAt: "2026-01-01T00:00:00.000Z", session: session("running") })],
      "idle",
    ],
    ["no chats", [], "idle"],
    ["an unrecognized session status", [thread({ session: session("thinking") })], "unknown"],
  ])("reads %s as %s", (_name, threads, expected) => {
    expect(shellActivity({ snapshotSequence: 1, projects: [], threads })).toBe(expected);
  });

  it("reads an error body as unknown", () => {
    expect(shellActivity({ _tag: "EnvironmentAuthError" })).toBe("unknown");
  });
});

describe("readLeaseActivity", () => {
  it("asks the remote shell with the broker token and treats anything else as unknown", async () => {
    const server = NodeHttp.createServer((request, response) => {
      if (
        request.url !== "/api/orchestration/shell" ||
        request.headers.authorization !== "Bearer broker"
      ) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ threads: [thread({ session: session("running") })] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
    const lease = (remoteAccess?: ProvisionedLease["remoteAccess"]) =>
      ({ leaseId: "lease", ...(remoteAccess ? { remoteAccess } : {}) }) as ProvisionedLease;
    try {
      expect(await readLeaseActivity(lease({ origin, brokerToken: "broker" }))).toBe("busy");
      expect(await readLeaseActivity(lease({ origin, brokerToken: "stale" }))).toBe("unknown");
      expect(await readLeaseActivity(lease())).toBe("unknown");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    expect(await readLeaseActivity(lease({ origin, brokerToken: "broker" }))).toBe("unknown");
  });
});
