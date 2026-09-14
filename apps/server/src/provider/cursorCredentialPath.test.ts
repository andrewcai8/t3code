import { expect, it } from "vite-plus/test";
import { cursorFileCredentialPath } from "./cursorCredentialPath.ts";

it("uses the Darwin home auth file independently of CLI config and XDG paths", () => {
  expect(
    cursorFileCredentialPath(
      { HOME: "/selected", CURSOR_CONFIG_DIR: "/other-config", XDG_CONFIG_HOME: "/other-xdg" },
      "darwin",
    ),
  ).toBe("/selected/.cursor/auth.json");
});

it("uses the Linux XDG file store, falling back to the home config directory", () => {
  expect(
    cursorFileCredentialPath(
      { HOME: "/selected", CURSOR_CONFIG_DIR: "/other-config", XDG_CONFIG_HOME: "/selected-xdg" },
      "linux",
    ),
  ).toBe("/selected-xdg/cursor/auth.json");
  expect(
    cursorFileCredentialPath({ HOME: "/selected", CURSOR_CONFIG_DIR: "/other-config" }, "linux"),
  ).toBe("/selected/.config/cursor/auth.json");
});

it("uses Windows roaming app data independently of HOME and CLI config", () => {
  expect(
    cursorFileCredentialPath(
      {
        APPDATA: "C:\\selected-appdata",
        HOME: "C:\\other-home",
        CURSOR_CONFIG_DIR: "C:\\other-config",
      },
      "win32",
    ),
  ).toBe("C:\\selected-appdata\\Cursor\\auth.json");
  expect(
    cursorFileCredentialPath({ USERPROFILE: "C:\\selected-user", HOME: "C:\\other-home" }, "win32"),
  ).toBe("C:\\selected-user\\AppData\\Roaming\\Cursor\\auth.json");
});
