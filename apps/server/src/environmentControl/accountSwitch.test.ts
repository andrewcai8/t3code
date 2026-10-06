import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, type GuestAccountSwitchInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  autoSwitchDue,
  switchLeaseAccount,
  type AccountSwitchPorts,
  type SwitchTarget,
} from "./accountSwitch.ts";
import { createProvisionedLeaseRegistry } from "./ProvisionedLeaseRegistry.ts";
import { ownerChat } from "./provisionedChats.ts";
import { boxShell, boxThread } from "./shellTestFixture.ts";

const layer = SqlitePersistence.layerMemory.pipe(Layer.provideMerge(NodeServices.layer));
const threadId = ThreadId.make("thread-chat");
const now = new Date("2026-10-06T12:00:00.000Z");

/** The chat stopped on a usage limit in `runId`, on the box's Claude instance. */
const limitedChat = (runId: string, fields: Record<string, unknown> = {}) =>
  boxThread(threadId, "project-app", "Chat", {
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-4-6" },
    latestRunId: runId,
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: "2026-10-06T15:00:00.000Z",
    ...fields,
  });

const account = (instanceId: string): SwitchTarget => ({
  instanceId,
  name: `Claude ${instanceId}`,
  displayName: `Claude ${instanceId}`,
  credential: {
    kind: "environment",
    variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: `${instanceId}-token` }],
  },
});

/**
 * A host with Claude accounts `claude-a`, `claude-b`, `claude-c` and a Codex one, whose box shows
 * `thread` and answers every switch with `answer`. Records what the box was sent.
 */
const host = (
  thread: () => Record<string, unknown>,
  answer: Awaited<ReturnType<AccountSwitchPorts["sendSwitch"]>> = {
    kind: "switched",
    continued: true,
  },
) => {
  const sent: Array<GuestAccountSwitchInput> = [];
  const ports: AccountSwitchPorts = {
    readShell: async () => boxShell([thread()]),
    accountDriver: async (instanceId) =>
      instanceId.startsWith("claude-") ? "claudeAgent" : "codex",
    pickAccount: async (_driver, exclude) =>
      ["claude-a", "claude-b", "claude-c"]
        .filter((instanceId) => !exclude.has(instanceId))
        .map(account)[0] ?? null,
    sendSwitch: async (_lease, input) => {
      sent.push(input);
      return answer;
    },
  };
  return { ports, sent };
};

const registerBox = Effect.gen(function* () {
  const leases = createProvisionedLeaseRegistry(yield* SqlClient.SqlClient);
  yield* Effect.promise(async () => {
    await leases.register({
      leaseId: "lease-1",
      sandboxId: "box-1",
      providerInstanceId: "claude-a",
      companionInstanceIds: ["codex-a"],
      owner: { environmentId: "box-env", threadId },
    });
    await leases.markActive({
      leaseId: "lease-1",
      remoteAccess: { origin: "https://box.example", brokerToken: "broker" },
    });
  });
  return leases;
});

it.effect("moves a limited chat once per run, to the next account, and continues it", () =>
  Effect.gen(function* () {
    const leases = yield* registerBox;
    let run = "run-1";
    const { ports, sent } = host(() => limitedChat(run));
    const switchNow = Effect.promise(async () => {
      const lease = (await leases.findById("lease-1"))!;
      const chat = ownerChat(await ports.readShell(lease), threadId)!;
      if (!autoSwitchDue(lease, chat)) return null;
      return switchLeaseAccount(lease, threadId, ports, leases, now);
    });

    const first = yield* switchNow;
    const again = yield* switchNow;
    run = "run-2";
    const next = yield* switchNow;

    expect([first, again, next]).toEqual([
      { kind: "switched", account: "Claude claude-b", continued: true },
      null,
      { kind: "switched", account: "Claude claude-c", continued: true },
    ]);
    expect(sent).toEqual([
      {
        driver: "claudeAgent",
        displayName: "Claude claude-b",
        credential: {
          kind: "environment",
          variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "claude-b-token" }],
        },
        threadId,
        continueRunId: "run-1",
      },
      {
        driver: "claudeAgent",
        displayName: "Claude claude-c",
        credential: {
          kind: "environment",
          variables: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "claude-c-token" }],
        },
        threadId,
        continueRunId: "run-2",
      },
    ]);
    const lease = yield* Effect.promise(() => leases.findById("lease-1"));
    expect({ accounts: lease?.accounts, limits: lease?.accountLimits }).toEqual({
      accounts: ["claude-c", "codex-a"],
      limits: [
        { instanceId: "claude-a", runId: "run-1", until: "2026-10-06T15:00:00.000Z" },
        { instanceId: "claude-b", runId: "run-2", until: "2026-10-06T15:00:00.000Z" },
      ],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("stops once every other account hit its limit, and handles that run once", () =>
  Effect.gen(function* () {
    const leases = yield* registerBox;
    let run = "run-1";
    const { ports, sent } = host(() => limitedChat(run));
    const switchNow = Effect.promise(async () => {
      const lease = (await leases.findById("lease-1"))!;
      const chat = ownerChat(await ports.readShell(lease), threadId)!;
      return autoSwitchDue(lease, chat)
        ? switchLeaseAccount(lease, threadId, ports, leases, now)
        : null;
    });

    const outcomes = [];
    for (const next of ["run-1", "run-2", "run-3", "run-3"]) {
      run = next;
      outcomes.push(yield* switchNow);
    }

    expect(outcomes).toEqual([
      { kind: "switched", account: "Claude claude-b", continued: true },
      { kind: "switched", account: "Claude claude-c", continued: true },
      {
        kind: "refused",
        reason: "no_account",
        message: "Every other account for this provider is out of usage or can't run in the cloud.",
      },
      null,
    ]);
    expect(sent.map((input) => input.continueRunId)).toEqual(["run-1", "run-2"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a working chat, and tries an old box once per run", () =>
  Effect.gen(function* () {
    const leases = yield* registerBox;
    const working = host(() => limitedChat("run-1", { status: "running" }));
    const old = host(() => limitedChat("run-1"), "missing");
    const before = yield* Effect.promise(() => leases.findById("lease-1"));

    const busy = yield* Effect.promise(() =>
      switchLeaseAccount(before!, threadId, working.ports, leases, now),
    );
    const unchanged = yield* Effect.promise(() => leases.findById("lease-1"));
    const outdated = yield* Effect.promise(() =>
      switchLeaseAccount(before!, threadId, old.ports, leases, now),
    );
    const after = yield* Effect.promise(() => leases.findById("lease-1"));

    expect([busy, outdated]).toEqual([
      {
        kind: "refused",
        reason: "busy",
        message: "This chat is working. Switch accounts once its turn ends.",
      },
      {
        kind: "refused",
        reason: "unsupported",
        message:
          "This cloud machine runs an older build. It can switch accounts after its next update.",
      },
    ]);
    expect(working.sent).toEqual([]);
    expect(unchanged).toEqual(before);
    expect({ accounts: after?.accounts, limits: after?.accountLimits }).toEqual({
      accounts: undefined,
      limits: [{ instanceId: "claude-a", runId: "run-1", until: "2026-10-06T15:00:00.000Z" }],
    });
    expect(
      autoSwitchDue(
        after!,
        ownerChat(yield* Effect.promise(() => old.ports.readShell(after!)), threadId)!,
      ),
    ).toBe(false);
  }).pipe(Effect.provide(layer)),
);
