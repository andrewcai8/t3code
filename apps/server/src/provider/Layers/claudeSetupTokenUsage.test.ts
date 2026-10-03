import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { rankAccounts } from "@t3tools/shared/usageLimits";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

import { type ClaudeCapabilities, makeClaudeHostProbe } from "../Drivers/claudeHostProbe.ts";
import { checkClaudeProviderStatus, probeClaudeCapabilities } from "./ClaudeProvider.ts";
import {
  CLAUDE_USAGE_TURN_PROMPT,
  rateLimitEventToUsageResponse,
} from "./claudeSetupTokenUsage.ts";
import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

/**
 * A `rate_limit_event` as a `claude setup-token` account streams it: no
 * top-level utilization, every window under the (untyped) `unifiedWindows`.
 */
const setupTokenEvent = (fiveHour: number, sevenDay: number) =>
  ({
    status: "allowed",
    resetsAt: 1_790_207_400,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: fiveHour, resetsAt: 1_790_207_400 },
      seven_day: { utilization: sevenDay, resetsAt: 1_790_672_400 },
    },
  }) as ClaudeSdk.SDKRateLimitInfo;

const setupTokenWindows = (fiveHour: number, sevenDay: number) =>
  [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: fiveHour,
      windowDurationMins: 300,
      resetsAt: "2026-09-23T23:50:00.000Z",
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: sevenDay,
      windowDurationMins: 10080,
      resetsAt: "2026-09-29T09:00:00.000Z",
    },
  ] as const;

const turnLimits = (info: ClaudeSdk.SDKRateLimitInfo) => {
  const response = rateLimitEventToUsageResponse(info);
  return response && claudeUsageResponseToLimits({ response, checkedAt }).limits;
};

describe("setup-token rate limit events", () => {
  it("updates every window a turn's rate_limit_event reports", () => {
    assert.deepEqual(claudeRateLimitEventToUpdate(setupTokenEvent(0.03, 0.44), noNames), {
      windows: setupTokenWindows(3, 44),
    });
  });

  it("keeps the named window when unifiedWindows carries none this build draws", () => {
    assert.deepEqual(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "seven_day",
          utilization: 0.5,
          ...({ unifiedWindows: {} } as object),
        },
        noNames,
      ),
      {
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 50,
            windowDurationMins: 10080,
          },
        ],
      },
    );
  });

  it("derives the windows get_usage cannot read from the probe turn's event", () => {
    assert.deepEqual(turnLimits(setupTokenEvent(0.03, 0.44)), {
      checkedAt,
      windows: setupTokenWindows(3, 44),
    });
  });

  it("reads nothing from an event with no account-wide window", () => {
    assert.equal(rateLimitEventToUsageResponse({ status: "allowed" }), undefined);
  });

  it("routes a chat to the setup-token account with the most headroom", () => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const account = (id: string, fiveHour: number, sevenDay: number) => ({
      instanceId: ProviderInstanceId.make(id),
      driver,
      usageLimits: turnLimits(setupTokenEvent(fiveHour, sevenDay)),
    });

    const ranked = rankAccounts(
      [
        account("claude_busy", 0.5, 0.1),
        account("claude_weekly", 0.03, 0.8),
        account("claude_fresh", 0.03, 0.44),
      ],
      Date.parse(checkedAt) + 60_000,
    );

    assert.deepEqual(
      ranked.map((entry) => entry.instanceId),
      ["claude_fresh", "claude_busy", "claude_weekly"],
    );
  });
});

it.effect("reads windows from one probe turn only for a setup-token account", () =>
  Effect.gen(function* () {
    const rateLimitInfo = setupTokenEvent(0.03, 0.44);
    let account: ClaudeSdk.AccountInfo = {};
    let usage: Pick<ClaudeSdk.SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits"> =
      { rate_limits_available: false, rate_limits: null };
    const spawned: unknown[] = [];
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt, options }) => {
      if (typeof prompt === "string") {
        spawned.push({ prompt, model: options?.model, tools: options?.tools });
        return (async function* () {
          yield { type: "system", subtype: "init" };
          yield { type: "rate_limit_event", rate_limit_info: rateLimitInfo };
          throw new Error("the probe turn must stop at its rate_limit_event");
        })() as unknown as ReturnType<typeof ClaudeSdk.query>;
      }
      spawned.push("initialize");
      return {
        initializationResult: async () => ({ account, commands: [] }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usage,
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const settings = decodeClaudeSettings({ binaryPath: "claude" });
    const hostProbe = yield* makeClaudeHostProbe(settings, process.env, undefined);
    const probe = () =>
      probeClaudeCapabilities(settings).pipe(Effect.flatMap(hostProbe.withSetupTokenUsage));

    account = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" };
    usage = { rate_limits_available: false, rate_limits: null };
    const setupToken = yield* probe();
    account = { email: "dev@example.com", subscriptionType: "max", tokenSource: "claude.ai" };
    usage = {
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
    };
    const keychain = yield* probe();

    assert.deepEqual(setupToken?.usage, {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 3, resets_at: "2026-09-23T23:50:00.000Z" },
        seven_day: { utilization: 44, resets_at: "2026-09-29T09:00:00.000Z" },
      },
    });
    assert.deepEqual(keychain?.usage, usage);
    assert.deepEqual(spawned, [
      "initialize",
      { prompt: CLAUDE_USAGE_TURN_PROMPT, model: "haiku", tools: [] },
      "initialize",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("spends at most one usage turn per 30 minutes on a setup-token account", () =>
  Effect.gen(function* () {
    const rateLimitInfo = {
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: { five_hour: { utilization: 0.03, resetsAt: 1_790_207_400 } },
    } as ClaudeSdk.SDKRateLimitInfo;
    let turns = 0;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
      if (typeof prompt === "string") {
        turns += 1;
        const failed = turns === 1;
        return (async function* () {
          if (failed) return;
          yield { type: "rate_limit_event", rate_limit_info: rateLimitInfo };
        })() as unknown as ReturnType<typeof ClaudeSdk.query>;
      }
      return {
        initializationResult: async () => ({
          account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" },
          commands: [],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          rate_limits_available: false,
          rate_limits: null,
        }),
      } as unknown as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const settings = decodeClaudeSettings({ binaryPath: "claude" });
    const hostProbe = yield* makeClaudeHostProbe(settings, process.env, undefined);
    const probe = () =>
      probeClaudeCapabilities(settings).pipe(
        Effect.flatMap(hostProbe.withSetupTokenUsage),
        Effect.map((capabilities) => ({ usage: capabilities?.usage, turns })),
      );

    const failedTurn = yield* probe();
    yield* TestClock.adjust("29 minutes");
    const withinTtl = yield* probe();
    yield* TestClock.adjust("1 minute");
    const afterTtl = yield* probe();

    assert.deepEqual(failedTurn, { usage: undefined, turns: 1 });
    assert.deepEqual(withinTtl, { usage: undefined, turns: 1 });
    assert.deepEqual(afterTtl, {
      usage: {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 3, resets_at: "2026-09-23T23:50:00.000Z" } },
      },
      turns: 2,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/** A Claude CLI that only answers `--version`. */
const versionOnlyClaude = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode("1.0.0\n")),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  ),
);

/** The status of a login whose probe reported these fields, on a host that named `accountEmail`. */
const statusWithAccountEmail = Effect.fn(function* (
  accountEmail: string,
  probed: { email?: string; tokenSource?: string },
) {
  const settings = decodeClaudeSettings({ accountEmail });
  const hostProbe = yield* makeClaudeHostProbe(settings, process.env, undefined);
  const capabilities = yield* Cache.make<unknown, ClaudeCapabilities | undefined>({
    capacity: 1,
    timeToLive: "5 minutes",
    lookup: () =>
      Effect.succeed({
        email: probed.email,
        subscriptionType: undefined,
        tokenSource: probed.tokenSource,
        apiProvider: undefined,
        slashCommands: [],
      }),
  });
  return yield* checkClaudeProviderStatus(settings, () =>
    hostProbe.readCapabilities(capabilities, "claude"),
  );
});

describe("setup-token account email", () => {
  it.effect("reports the configured account email for a setup-token login", () =>
    Effect.gen(function* () {
      const status = yield* statusWithAccountEmail("work@example.com", {
        tokenSource: "CLAUDE_CODE_OAUTH_TOKEN",
      });
      assert.strictEqual(status.auth.status, "authenticated");
      assert.strictEqual(status.auth.email, "work@example.com");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, versionOnlyClaude))),
  );

  it.effect("prefers the email a login reports over the configured one", () =>
    Effect.gen(function* () {
      const status = yield* statusWithAccountEmail("stale@example.com", {
        email: "claude@example.com",
      });
      assert.strictEqual(status.auth.email, "claude@example.com");
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, versionOnlyClaude))),
  );
});
