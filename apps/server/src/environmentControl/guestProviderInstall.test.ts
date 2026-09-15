import { describe, expect, it } from "vite-plus/test";

import { guestProviderInstallCommand, withGuestProviderInstall } from "./guestProviderInstall.ts";

describe("guestProviderInstallCommand", () => {
  it("installs Codex into the isolated home prefix", () => {
    expect(guestProviderInstallCommand("codex")).toBe(
      'npm install --global --no-fund --no-audit @openai/codex@latest && "$HOME/.local/bin/codex" --version',
    );
  });

  it("leaves unknown drivers without a guest install", () => {
    expect(guestProviderInstallCommand("grok")).toBeUndefined();
    expect(guestProviderInstallCommand(undefined)).toBeUndefined();
  });
});

describe("withGuestProviderInstall", () => {
  it("adds the closed install command when the selected driver has one", () => {
    expect(withGuestProviderInstall({ port: 1 }, "claudeAgent")).toEqual({
      port: 1,
      providerInstall:
        'npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest && "$HOME/.local/bin/claude" --version',
    });
  });

  it("does not add a field when there is nothing to install", () => {
    expect(withGuestProviderInstall({ port: 1 }, undefined)).toEqual({ port: 1 });
  });
});
