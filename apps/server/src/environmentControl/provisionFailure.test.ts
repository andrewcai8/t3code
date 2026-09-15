import { describe, expect, it } from "vite-plus/test";

import { provisionFailureMessage } from "./provisionFailure.ts";

describe("provisionFailureMessage", () => {
  it("keeps the remote command detail so a failed prepare is actionable", () => {
    expect(
      provisionFailureMessage(
        new Error("Remote preparation failed: Preparation command timed out: git fetch"),
        "Remote preparation did not finish. Retry the same request to resume.",
      ),
    ).toBe("Remote preparation failed: Preparation command timed out: git fetch");
  });

  it("redacts credentials that git or auth helpers leak into stderr", () => {
    expect(
      provisionFailureMessage(
        new Error("fatal: AUTHORIZATION: basic abc123 and x-access-token:secret@github.com"),
        "fallback",
      ),
    ).toBe("fatal: <redacted> and <redacted>@github.com");
  });

  it("falls back when the provider threw a nameless error", () => {
    expect(provisionFailureMessage({}, "Remote preparation did not finish.")).toBe(
      "Remote preparation did not finish.",
    );
  });
});
