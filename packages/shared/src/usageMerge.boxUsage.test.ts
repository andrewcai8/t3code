import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeUsage, type EnvironmentUsage } from "./usageMerge.ts";

function bucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  return {
    day: "2026-08-07" as UsageDay,
    provider: "claude",
    model: "claude-fable-5",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    costUsd: 10,
    cacheSavingsUsd: 2,
    costSource: "modelPriced",
    records: 5,
    unpricedRecords: 0,
    sessions: 1,
    ...overrides,
  };
}

function summary(
  buckets: readonly UsageBucket[],
  sources: readonly {
    provider: UsageProviderKind;
    hostId: string;
    homePath: string;
    volumeId?: string;
    sourcePath?: string;
    status?: UsageSource["status"];
    distinctSessions?: number;
  }[],
  contractVersion: number = USAGE_CONTRACT_VERSION,
): UsageSummary {
  return {
    contractVersion,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets,
    sources: sources.map((source) => ({
      fingerprint: {
        hostId: source.hostId,
        provider: source.provider,
        resolvedHomePath: source.homePath,
        volumeId: source.volumeId ?? `vol-${source.hostId}`,
      },
      status: source.status ?? "ok",
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: source.distinctSessions ?? 1,
      message: null,
      ...(source.sourcePath === undefined ? {} : { sourcePath: source.sourcePath }),
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 10 },
    scanDurationMs: 1,
  };
}

function environment(id: string, usageSummary: UsageSummary): EnvironmentUsage {
  return { environmentId: id as EnvironmentId, label: id, summary: usageSummary };
}

describe("a host keeping cloud box usage", () => {
  const boxHome = "/home/user/.claude/projects";
  const retiredHome = "/state/cloud-box-usage";
  const tokens = (uncachedInputTokens: number) => ({
    uncachedInputTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
  const host = summary(
    [
      bucket({ sourcePath: "/root/.claude/projects", totals: tokens(1) }),
      bucket({ sourcePath: `lease-a:${boxHome}`, totals: tokens(10) }),
      bucket({ sourcePath: `lease-b:${boxHome}`, totals: tokens(100) }),
      bucket({ sourcePath: retiredHome, totals: tokens(1000) }),
    ],
    [
      { provider: "claude", hostId: "host", homePath: "/root/.claude/projects" },
      {
        provider: "claude",
        hostId: "lease-a",
        homePath: boxHome,
        sourcePath: `lease-a:${boxHome}`,
        status: "partial",
      },
      {
        provider: "claude",
        hostId: "lease-b",
        homePath: boxHome,
        sourcePath: `lease-b:${boxHome}`,
        status: "partial",
      },
      { provider: "claude", hostId: "host", homePath: retiredHome, volumeId: "" },
    ],
  );
  const liveBoxA = summary(
    [bucket({ sourcePath: boxHome, totals: tokens(30) })],
    [{ provider: "claude", hostId: "lease-a", homePath: boxHome }],
  );
  const merge = (hostSummary: UsageSummary, hostReadAt: string, boxReadAt: string) =>
    mergeUsage(
      [
        environment("host", { ...hostSummary, readAt: hostReadAt }),
        environment("box-a", { ...liveBoxA, readAt: boxReadAt }),
      ],
      USAGE_CONTRACT_VERSION,
    );
  const readOrders = [
    ["the host read last", "2026-08-07T01:00:00.000Z", "2026-08-07T00:00:00.000Z"],
    ["the box read last", "2026-08-07T00:00:00.000Z", "2026-08-07T01:00:00.000Z"],
  ] as const;

  it.each(readOrders)(
    "counts a connected box's live scan over its stored copy, when %s",
    (_name, hostReadAt, boxReadAt) => {
      expect(merge(host, hostReadAt, boxReadAt).totalTokens).toBe(1131);
    },
  );

  it.each(readOrders)(
    "still counts a connected box for a client that ignores source paths, when %s",
    (_name, hostReadAt, boxReadAt) => {
      const oldClientHost = {
        ...host,
        sources: host.sources.map(({ sourcePath: _sourcePath, ...source }) => source),
      };
      // Stored per-box cells stay invisible; the live box and retired usage count.
      expect(merge(oldClientHost, hostReadAt, boxReadAt).totalTokens).toBe(1031);
    },
  );
});
