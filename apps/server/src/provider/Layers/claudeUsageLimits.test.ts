import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { rankAccounts } from "@t3tools/shared/usageLimits";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeRateLimitEventToUpdate,
  claudeUsageReadToLimits,
  claudeUsageResponseToLimits,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });
});

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
  }) as SDKRateLimitInfo;

const setupTokenWindows = (fiveHour: number, sevenDay: number) => [
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
];

describe("setup-token accounts", () => {
  it("updates every window a turn's rate_limit_event reports", () => {
    expect(claudeRateLimitEventToUpdate(setupTokenEvent(0.03, 0.44), noNames)).toEqual({
      windows: setupTokenWindows(3, 44),
    });
  });

  it("derives the windows get_usage cannot read from the probe turn's event", () => {
    const unavailable = claudeUsageReadToLimits({
      read: {
        source: "usageEndpoint",
        response: { rate_limits_available: false, rate_limits: null },
      },
      names: noNames,
      checkedAt,
    });
    const derived = claudeUsageReadToLimits({
      read: { source: "rateLimitEvent", info: setupTokenEvent(0.03, 0.44) },
      names: noNames,
      checkedAt,
    });

    expect(unavailable.limits).toEqual({
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported" },
    });
    expect(derived.limits).toEqual({ checkedAt, windows: setupTokenWindows(3, 44) });
  });

  it("treats a failed probe turn, or one with no drawable window, as a failed read", () => {
    const failed = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: "Claude did not report usage windows." },
    };
    for (const info of [undefined, { status: "allowed" } as const]) {
      expect(
        claudeUsageReadToLimits({
          read: { source: "rateLimitEvent", info },
          names: noNames,
          checkedAt,
        }).limits,
      ).toEqual(failed);
    }
  });

  it("keeps the named window when unifiedWindows carries none this build draws", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed",
          rateLimitType: "seven_day",
          utilization: 0.5,
          ...({ unifiedWindows: {} } as object),
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 50,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("routes a chat to the setup-token account with the most headroom", () => {
    const driver = ProviderDriverKind.make("claudeAgent");
    const account = (id: string, fiveHour: number, sevenDay: number) => ({
      instanceId: ProviderInstanceId.make(id),
      driver,
      usageLimits: claudeUsageReadToLimits({
        read: { source: "rateLimitEvent", info: setupTokenEvent(fiveHour, sevenDay) },
        names: noNames,
        checkedAt,
      }).limits,
    });
    const now = Date.parse(checkedAt) + 60_000;

    const ranked = rankAccounts(
      [
        account("claude_busy", 0.5, 0.1),
        account("claude_weekly", 0.03, 0.8),
        account("claude_fresh", 0.03, 0.44),
      ],
      now,
    );

    expect(ranked.map((entry) => entry.instanceId)).toEqual([
      "claude_fresh",
      "claude_busy",
      "claude_weekly",
    ]);
  });
});
