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

/** Box CLIs every Namespace Mac gets. Credentials arrive through the environment. */
const guestToolPins = {
  awsCli: {
    version: "2.37.4",
    sha256: "6cba8327461d2b804e575fd841272951eecb253b2ca94c8a58acd19d5f283786",
  },
  wrangler: "4.141.0",
};

/**
 * Installs the AWS CLI and wrangler into the isolated home without sudo. Each
 * tool is skipped when its pinned version is already there, so a resumed Mac
 * pays only two file checks. The AWS CLI lands in a versioned directory by
 * rename, so a download cut short never passes for an install, and a new pin
 * replaces every older version.
 */
export function guestToolInstallCommand(pins = guestToolPins): string {
  return [
    "set -eu",
    `aws="$HOME/.local/lib/aws-cli-${pins.awsCli.version}"`,
    'if [ ! -x "$aws/aws" ]; then',
    '  rm -rf "$HOME/.local/lib"/aws-cli-*',
    '  mkdir -p "$aws.partial"',
    `  curl -fsSL --retry 3 --connect-timeout 30 --max-time 900 https://awscli.amazonaws.com/AWSCLIV2-${pins.awsCli.version}.pkg -o "$aws.partial/aws.pkg"`,
    `  printf '%s  %s\\n' ${pins.awsCli.sha256} "$aws.partial/aws.pkg" | shasum -a 256 -c -s`,
    '  pkgutil --expand-full "$aws.partial/aws.pkg" "$aws.partial/expanded"',
    '  mv "$aws.partial/expanded/aws-cli.pkg/Payload/aws-cli" "$aws"',
    '  rm -rf "$aws.partial"',
    "fi",
    'ln -sfn "$aws/aws" "$HOME/.local/bin/aws"',
    `grep -qs '"version": "${pins.wrangler}"' "$HOME/.local/lib/node_modules/wrangler/package.json" || ` +
      `npm install --global --no-fund --no-audit wrangler@${pins.wrangler}`,
  ].join("\n");
}
