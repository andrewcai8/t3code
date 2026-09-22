/** Commands the retained E2B/Namespace runners already used to put the agent CLI on PATH. */

export function guestProviderInstallCommand(kind: string | undefined): string | undefined {
  if (kind === "codex")
    return 'npm install --global --no-fund --no-audit @openai/codex@latest && "$HOME/.local/bin/codex" --version';
  if (kind === "claudeAgent")
    return 'npm install --global --no-fund --no-audit @anthropic-ai/claude-code@latest && "$HOME/.local/bin/claude" --version';
  if (kind === "cursor")
    return (
      "curl https://cursor.com/install -fsS | bash && " +
      'test -x "$HOME/.local/bin/agent" && ' +
      'if [ ! -e "$HOME/.local/bin/cursor-agent" ]; then ln -s agent "$HOME/.local/bin/cursor-agent"; fi'
    );
}

/**
 * A preparation spec with the command that installs its agent CLIs.
 *
 * A manifest frozen with `providerInstall` already names every CLI it runs. An
 * older one predates that field, and derives the one command from its driver
 * exactly as it always has, because the guest hashes the whole spec as its
 * preparation identity.
 */
export function withGuestProviderInstall<T extends object>(
  input: T,
  agentDriver: string | undefined,
): T | (T & { providerInstall: string }) {
  if ("providerInstall" in input && input.providerInstall) return input;
  const providerInstall = guestProviderInstallCommand(agentDriver);
  return providerInstall ? { ...input, providerInstall } : input;
}
