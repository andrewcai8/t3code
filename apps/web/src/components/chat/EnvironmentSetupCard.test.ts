import { describe, expect, it } from "vite-plus/test";

import {
  environmentSetupDescription,
  environmentSetupHeader,
  type CloudEnvironmentSetupSnapshot,
} from "./EnvironmentSetupCard";

const base: CloudEnvironmentSetupSnapshot = {
  provider: "e2b",
  phase: "creating",
  startedAt: "2026-01-01T00:00:00Z",
};

describe("environment setup copy", () => {
  it("names the in-chat preparing state and repository checkout", () => {
    expect(environmentSetupHeader(base)).toBe("Preparing environment");
    expect(environmentSetupDescription(base)).toBe(
      "Setting up the environment. This can take a few minutes.",
    );
    expect(environmentSetupDescription({ ...base, repository: "example/megpt-mono" })).toBe(
      "Setting up the environment and cloning example/megpt-mono.",
    );
  });

  it("surfaces the failure on the card", () => {
    const failed: CloudEnvironmentSetupSnapshot = {
      ...base,
      phase: "failed",
      error: "Preparation command timed out",
    };
    expect(environmentSetupHeader(failed)).toBe("Environment setup failed");
    expect(environmentSetupDescription(failed)).toBe("Preparation command timed out");
  });
});
