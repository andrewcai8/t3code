import { describe, expect, it } from "vite-plus/test";
import { AuthenticationError, SandboxError, SandboxNotFoundError } from "e2b";
import { e2bResumeDecision } from "./e2bResume.ts";

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
      message: "E2B did not answer within 120 s",
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
