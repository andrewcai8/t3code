// @effect-diagnostics nodeBuiltinImport:off - mirrors Cursor's platform-specific file credential store.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// CURSOR_CONFIG_DIR controls CLI configuration, not its file credential store.
export function cursorFileCredentialPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  defaultHome = NodeOS.homedir(),
): string {
  const home = (platform === "win32" ? environment.USERPROFILE : environment.HOME) ?? defaultHome;
  if (platform === "win32")
    return NodePath.win32.join(
      environment.APPDATA || NodePath.win32.join(home, "AppData", "Roaming"),
      "Cursor",
      "auth.json",
    );
  if (platform === "darwin") return NodePath.posix.join(home, ".cursor", "auth.json");
  return NodePath.posix.join(
    environment.XDG_CONFIG_HOME || NodePath.posix.join(home, ".config"),
    "cursor",
    "auth.json",
  );
}
