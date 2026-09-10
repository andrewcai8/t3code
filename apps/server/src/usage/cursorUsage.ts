import type { ServerSettings, UsageSource, UsageSummaryInput } from "@t3tools/contracts";

import { readCursorDashboard, type CursorHistory } from "../provider/cursorDashboard.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import type { UsageAggregator } from "./usageAggregation.ts";

type ProviderInstance =
  ServerSettings["providerInstances"][keyof ServerSettings["providerInstances"]];

/** Resolves local aliases before contributing each account's requests once. */
export async function readCursorUsage(input: {
  readonly instances: ServerSettings["providerInstances"];
  readonly environment: NodeJS.ProcessEnv;
  readonly input: UsageSummaryInput;
  readonly readFile: (filePath: string) => Promise<string>;
  readonly aggregator: UsageAggregator;
  readonly dashboard?: typeof readCursorDashboard;
}): Promise<readonly UsageSource[]> {
  const accounts = new Map<string, { source: UsageSource; history: CursorHistory | null }>();
  const readInstance = async ([instanceId, instance]: readonly [string, ProviderInstance]) => {
    if (instance.driver !== "cursor" || instance.enabled === false) return null;
    let source: UsageSource = {
      fingerprint: {
        kind: "unavailable",
        provider: "cursor",
        sourceId: instanceId,
        label: instance.displayName || instanceId,
      },
      status: "failed",
      scannedFiles: 0,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 0,
      message:
        "Cursor account usage is unavailable. Check this instance's existing login and file credential store.",
    };
    let key = `unavailable:${instanceId}`;
    let retry: (() => Promise<CursorHistory>) | undefined;
    try {
      const dashboard = await (input.dashboard ?? readCursorDashboard)(
        mergeProviderInstanceEnvironment(instance.environment, input.environment),
        input.readFile,
      );
      const account = await dashboard.identify();
      key = account.sourceId;
      source = {
        ...source,
        fingerprint: {
          kind: "account",
          provider: "cursor",
          sourceId: key,
          label: instance.displayName || "Cursor account",
        },
      };
      const history = await dashboard.readHistory(input.input);
      retry = () => dashboard.readHistory(input.input);
      return {
        key,
        source: {
          ...source,
          status: history.status,
          readAt: history.readAt,
          message: history.message,
          malformedRecords: history.malformedRecords,
        },
        history,
        retry,
      };
    } catch {
      return { key, source, history: null, retry };
    }
  };

  // Cursor history is remote and each configured account is independent. Read
  // accounts together so one slow dashboard cannot hold every other account
  // behind it; the ordered merge below keeps alias precedence deterministic.
  const results = await Promise.all(Object.entries(input.instances).map(readInstance));
  for (const result of results) {
    if (result === null) continue;
    const previous = accounts.get(result.key);
    if (previous?.source.status === "ok") continue;
    let history = result.history;
    if (history?.status !== "ok" && previous?.history !== undefined && previous.history !== null) {
      try {
        const retried = await result.retry?.();
        if (retried?.status === "ok") history = retried;
      } catch {
        // Keep the first partial result when the alias retry also fails.
      }
    }
    if (history?.status === "ok" || previous?.history === undefined) {
      const nextSource =
        history !== null && history !== result.history
          ? {
              ...result.source,
              status: history.status,
              readAt: history.readAt,
              message: history.message,
              malformedRecords: history.malformedRecords,
            }
          : result.source;
      accounts.set(result.key, {
        source: nextSource,
        history,
      });
    }
  }
  const sources: UsageSource[] = [];
  for (const [sourceId, { source, history }] of accounts) {
    const sessions = new Set<string>();
    for (const event of history?.events ?? []) {
      if (!event.tokenUsage) continue;
      const usage = event.tokenUsage;
      if (
        input.aggregator.add({
          provider: "cursor",
          sourceId,
          timestampMs: Number(event.timestamp),
          model: event.model,
          sessionId: event.conversationId ?? "",
          dedupeKey: null,
          totals: {
            uncachedInputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cachedInputTokens: usage.cacheReadTokens ?? 0,
            cacheCreationTokens: usage.cacheWriteTokens ?? 0,
            reasoningTokens: 0,
          },
          reportedCostUsd: (usage.totalCents ?? 0) / 100,
        }) &&
        event.conversationId
      )
        sessions.add(event.conversationId);
    }
    sources.push({ ...source, distinctSessions: sessions.size });
  }
  return sources;
}
