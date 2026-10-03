import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageSummary } from "./usage.ts";

/** Asks an environment for its hourly UTC usage since an instant, for a host to keep. */
export const UsageHistoryInput = Schema.Struct({
  sinceTime: TrimmedNonEmptyString,
});
export type UsageHistoryInput = typeof UsageHistoryInput.Type;

/**
 * A machine's own hourly UTC history, as a host would pull it from a cloud box,
 * pushed to a host that no client of the machine connects to. Each import
 * replaces what the host keeps for `machineId`.
 */
export const UsageImportInput = Schema.Struct({
  /** Stable across hostname changes, unlike the sources' `hostId`. */
  machineId: TrimmedNonEmptyString,
  history: UsageSummary,
});
export type UsageImportInput = typeof UsageImportInput.Type;

/** What the host now keeps for the machine. */
export const UsageImportResult = Schema.Struct({
  sources: NonNegativeInt,
  buckets: NonNegativeInt,
});
export type UsageImportResult = typeof UsageImportResult.Type;
