import { WS_METHODS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getSlowRpcAckRequests,
  resetRequestLatencyStateForTests,
  trackRpcRequestSent,
} from "./requestLatencyState";

describe("a cloud machine's resume", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRequestLatencyStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is flagged only once E2B's retries run long", () => {
    trackRpcRequestSent("resume", WS_METHODS.environmentControlResume);
    vi.advanceTimersByTime(70_000);
    expect(getSlowRpcAckRequests()).toEqual([]);

    vi.advanceTimersByTime(50_000);
    expect(getSlowRpcAckRequests().map((request) => request.requestId)).toEqual(["resume"]);
  });
});
