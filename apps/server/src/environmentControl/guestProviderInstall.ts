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

export function withGuestProviderInstall<T extends object>(
  input: T,
  agentDriver: string | undefined,
): T | (T & { providerInstall: string }) {
  const providerInstall = guestProviderInstallCommand(agentDriver);
  return providerInstall ? { ...input, providerInstall } : input;
}
