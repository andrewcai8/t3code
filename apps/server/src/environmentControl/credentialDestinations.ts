/**
 * Where each driver reads its login inside a provisioned home, relative to it. The counterpart of
 * `credentialVariables`: an environment must not get both, because a CLI prefers a credential file
 * over the variables, so a leftover file would silently replace the credential provisioning selected.
 */
/** The guest's Cursor instance (id `cursor`) moves this file into its secret store on start. */
export const cursorGuestLoginDestination = ".t3/userdata/provider-auth/cursor/cursor.json";

export const credentialDestinations = {
  codex: [".codex/auth.json"],
  // The cursor-agent CLI's files stay listed so no stale copy survives.
  cursor: [cursorGuestLoginDestination, ".cursor/auth.json", ".config/cursor/auth.json"],
  claudeAgent: [".claude/.credentials.json"],
};
