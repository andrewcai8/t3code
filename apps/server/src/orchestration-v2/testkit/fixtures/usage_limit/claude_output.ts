import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertBaseProjection, projectionFor } from "../shared.ts";

/** The usage-limit failure Claude reports through a CLIProxyAPI hub with every account spent. */
export function claudeUsageLimitFailure(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });
  const error = projectionFor(result, transcript.scenario).turnItems.find(
    (item) => item.type === "error",
  );
  if (error?.type !== "error") throw new Error("expected an error turn item");
  assert.equal(error.failure.class, "usage_limit");
  assert.equal(error.failure.code, "api_error_429");
  return error.failure;
}

export function assertClaudeUsageLimitOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // The hub drops the upstream rate-limit headers and no hub is known here, so the fork assumes
  // the reset is 30 minutes after the failure.
  assert.equal(claudeUsageLimitFailure(result, transcript).resetAt, "1970-01-01T00:30:00.002Z");
}
