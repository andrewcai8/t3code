import { describe, expect, it, vi } from "vite-plus/test";
import { AuthenticationError, SandboxError, SandboxNotFoundError } from "e2b";
import { connectResumingE2b, e2bResumeDecision, type E2bResumeRetry } from "./e2bResume.ts";

describe("e2bResumeDecision", () => {
  it("retries E2B's placement timeout", () => {
    const placement = Object.assign(
      new SandboxError(
        "504: Failed to place sandbox: placement timed out after 2 attempt(s), please retry",
      ),
      { statusCode: 504 },
    );
    expect(e2bResumeDecision(placement)).toEqual({
      kind: "retry",
      code: "http_504",
      message: "504: Failed to place sandbox: placement timed out after 2 attempt(s), please retry",
    });
  });

  it("retries a request that E2B did not answer in time", () => {
    expect(
      e2bResumeDecision(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    ).toEqual({
      kind: "retry",
      code: "request_timeout",
      message: "E2B did not answer within 80 s",
    });
  });

  it("fails a sandbox E2B no longer has", () => {
    expect(
      e2bResumeDecision(new SandboxNotFoundError("Paused sandbox retained not found")),
    ).toEqual({ kind: "fail" });
  });

  it("fails rejected credentials", () => {
    expect(
      e2bResumeDecision(
        new AuthenticationError("Unauthorized, please check your credentials. - Invalid API key"),
      ),
    ).toEqual({ kind: "fail" });
  });
});

describe("connectResumingE2b", () => {
  it("names the sandbox and attempt count once placement keeps timing out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const placement = Object.assign(
        new SandboxError("504: Failed to place sandbox: placement timed out after 2 attempt(s)"),
        { statusCode: 504 },
      );
      let attempts = 0;
      const retries: E2bResumeRetry[] = [];
      const connected = connectResumingE2b(
        "retained",
        async () => {
          attempts++;
          throw placement;
        },
        (retry) => retries.push(retry),
      ).then(
        () => "connected",
        (error: Error) => error.message,
      );
      const [outcome] = await Promise.all([connected, vi.runAllTimersAsync()]);
      expect(outcome).toBe(
        "E2B could not resume sandbox retained after 3 attempts: 504: Failed to place sandbox: placement timed out after 2 attempt(s)",
      );
      expect(attempts).toBe(3);
      expect(retries.map((retry) => retry.attempt)).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });
});
