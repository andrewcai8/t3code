/**
 * Where each driver reads its login inside a provisioned home, relative to it.
 *
 * The counterpart of `credentialVariables`: whichever of these a provisioned
 * environment gets, it must not get both. A CLI that finds a credential file
 * prefers it over the variables, so a file left behind by a home-file copy
 * silently replaces the credential provisioning selected.
 */
export const credentialDestinations = {
  codex: [".codex/auth.json"],
  cursor: [".cursor/auth.json", ".config/cursor/auth.json"],
  claudeAgent: [".claude/.credentials.json"],
};
