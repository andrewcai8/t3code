/**
 * Installs a global npm CLI unless the copy already in the isolated home is
 * the registry's latest and runs. A warm base or a resumed box almost always
 * has it, and reinstalling the same version cost each chat about ten seconds a
 * CLI. An install killed between unpacking and linking leaves the package
 * without its command, which the check has to see through.
 */
const npmLatest = (name: string, bin: string) =>
  `{ v=$(npm view ${name}@latest version 2>/dev/null) && [ -n "$v" ] && ` +
  `grep -Eqs "\\"version\\": ?\\"$v\\"" "$HOME/.local/lib/node_modules/${name}/package.json" && ` +
  `"$HOME/.local/bin/${bin}" --version >/dev/null 2>&1 || ` +
  `npm install --global --no-fund --no-audit ${name}@latest; } && "$HOME/.local/bin/${bin}" --version`;

/**
 * Cursor publishes one installer script per release, so an installer that
 * checksums the same as the one last run has nothing new to install. When
 * cursor.com cannot be reached, an agent already installed is kept.
 */
const cursorLatest =
  "if s=$(curl https://cursor.com/install -fsS); then c=$(printf '%s' \"$s\" | cksum) && " +
  '{ { [ -x "$HOME/.local/bin/agent" ] && [ "$(cat "$HOME/.local/share/cursor-agent/installer.cksum" 2>/dev/null)" = "$c" ]; } || ' +
  '{ printf \'%s\\n\' "$s" | bash && mkdir -p "$HOME/.local/share/cursor-agent" && ' +
  'printf \'%s\\n\' "$c" > "$HOME/.local/share/cursor-agent/installer.cksum"; }; }; fi && ' +
  'test -x "$HOME/.local/bin/agent" && ' +
  'if [ ! -e "$HOME/.local/bin/cursor-agent" ]; then ln -s agent "$HOME/.local/bin/cursor-agent"; fi';

/** Puts a driver's agent CLI on PATH in the isolated home, at its latest release. */
export function guestProviderInstallCommand(kind: string | undefined): string | undefined {
  if (kind === "codex") return npmLatest("@openai/codex", "codex");
  if (kind === "claudeAgent") return npmLatest("@anthropic-ai/claude-code", "claude");
  if (kind === "cursor") return cursorLatest;
}

/**
 * The install a manifest frozen before `providerInstall` runs. The guest
 * hashes the whole spec as its preparation identity, so these never change.
 */
function unfrozenProviderInstallCommand(kind: string | undefined): string | undefined {
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
 * exactly as it always has.
 */
export function withGuestProviderInstall<T extends object>(
  input: T,
  agentDriver: string | undefined,
): T | (T & { providerInstall: string }) {
  if ("providerInstall" in input && input.providerInstall) return input;
  const providerInstall = unfrozenProviderInstallCommand(agentDriver);
  return providerInstall ? { ...input, providerInstall } : input;
}

/** Box CLIs every Namespace Mac gets. Credentials arrive through the environment. */
const guestToolPins = {
  // MeGPT pins the same AWS CLI in install_pinned_aws_cli, so its boxes agree on Linux and macOS.
  awsCli: {
    version: "2.36.45",
    sha256: "351c45fc36ac36f5af65708625087f27e654bd9319a843dbb9dfeea21c912be3",
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
