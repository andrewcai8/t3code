// @effect-diagnostics globalTimers:off - this Promise helper backs off between E2B requests outside Effect.
import { SandboxError } from "e2b";

/**
 * One E2B connect request. Restoring a box paused for hours took 70 s before
 * E2B answered with a placement timeout, so the 15 s API timeout gave up first.
 */
const E2B_RESUME_REQUEST_TIMEOUT_MS = 80_000;
const E2B_RESUME_ATTEMPTS = 3;
const E2B_RESUME_BACKOFF_MS = 2_000;

export type E2bResumeDecision =
  | {
      readonly kind: "retry";
      readonly code: "http_504" | "request_timeout";
      readonly message: string;
    }
  | { readonly kind: "fail" };

export interface E2bResumeRetry {
  readonly sandboxId: string;
  readonly attempt: number;
  readonly code: string;
  readonly message: string;
}

/** Whether a failed E2B connect is worth repeating. E2B asks for a retry when placement times out. */
export function e2bResumeDecision(cause: unknown): E2bResumeDecision {
  if (cause instanceof SandboxError && cause.statusCode === 504)
    return { kind: "retry", code: "http_504", message: cause.message };
  if (cause instanceof DOMException && cause.name === "TimeoutError")
    return {
      kind: "retry",
      code: "request_timeout",
      message: `E2B did not answer within ${E2B_RESUME_REQUEST_TIMEOUT_MS / 1_000} s`,
    };
  return { kind: "fail" };
}

/**
 * Connects to (and so resumes) an E2B sandbox, retrying placement timeouts.
 * Bounded by 3 attempts of 80 s plus 6 s of backoff, about 4 minutes.
 */
export async function connectResumingE2b<A>(
  sandboxId: string,
  connect: (requestTimeoutMs: number) => Promise<A>,
  onRetry: (retry: E2bResumeRetry) => void = () => {},
): Promise<A> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect(E2B_RESUME_REQUEST_TIMEOUT_MS);
    } catch (cause) {
      const decision = e2bResumeDecision(cause);
      if (decision.kind === "fail") throw cause;
      if (attempt === E2B_RESUME_ATTEMPTS)
        throw new Error(
          `E2B could not resume sandbox ${sandboxId} after ${attempt} attempts: ${decision.message}`,
          { cause },
        );
      onRetry({ sandboxId, attempt, code: decision.code, message: decision.message });
      await new Promise((resolve) => setTimeout(resolve, E2B_RESUME_BACKOFF_MS * attempt));
    }
  }
}
