import type { ServerSettings, UsageSource, UsageSummaryInput } from "@t3tools/contracts";

import { readCursorDashboard, type CursorHistory } from "../provider/cursorDashboard.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import type { UsageAggregator } from "./usageAggregation.ts";

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
  for (const [instanceId, instance] of Object.entries(input.instances)) {
    if (instance.driver !== "cursor" || instance.enabled === false) continue;
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
      if (accounts.get(key)?.source.status === "ok") continue;
      const history = await dashboard.readHistory(input.input);
      if (history.status === "ok" || !accounts.get(key)?.history) {
        accounts.set(key, {
          source: {
            ...source,
            status: history.status,
            readAt: history.readAt,
            message: history.message,
            malformedRecords: history.malformedRecords,
          },
          history,
        });
      }
    } catch {
      if (!accounts.has(key)) accounts.set(key, { source, history: null });
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
