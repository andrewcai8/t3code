import { expect, it } from "vite-plus/test";

import { ProvisionRefused, accountAuthPath, enableChildProvider, repositoryUrl } from "./driver.ts";

it("reads each account's credentials from its own shadow home", () => {
  // Every entry in a shadow home except auth.json links back to the shared
  // one, so that file is the whole of an account's identity.
  expect(accountAuthPath("codex_ac3", "/home/a")).toBe("/home/a/.codex_ac3/auth.json");
});

it("leaves the default instance on the real Codex home", () => {
  expect(accountAuthPath("codex", "/home/a")).toBe("/home/a/.codex/auth.json");
});

it("resolves Cursor accounts from their isolated homes", () => {
  expect(accountAuthPath("cursor_work", "/home/a")).toBe(
    "/home/a/.t3/userdata/cursor-homes/cursor_work/.cursor/auth.json",
  );
});

it("accepts the spellings a person actually pastes", () => {
  const expected = "https://github.com/owner/name.git";
  for (const spelling of [
    "owner/name",
    "https://github.com/owner/name",
    "https://www.github.com/owner/name",
    "https://github.com/owner/name.git",
  ])
    expect(repositoryUrl(spelling), spelling).toBe(expected);
});

it("refuses a repository that names no owner", () => {
  expect(() => repositoryUrl("justaname")).toThrow(/owner\/name/);
});

it("carries the reason a request was declined", () => {
  // A declined request is an answer the caller can act on, so the reason has
  // to survive being thrown rather than collapsing into a generic failure.
  const refusal = new ProvisionRefused("credentials", "No credentials for 'codex_x'.");
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal.reason).toBe("credentials");
  expect(refusal.message).toContain("codex_x");
});

it("names a missing workspace file rather than provisioning a broken checkout", () => {
  // A configured file that is absent means the environment would come up
  // looking fine and fail the first time anything ran. Saying so beats
  // handing back an environment the caller has to debug.
  const refusal = new ProvisionRefused(
    "unconfigured",
    "Workspace file '/secrets/backend.env' is configured but missing on this machine.",
  );
  expect(refusal.reason).toBe("unconfigured");
  expect(refusal.message).toContain("/secrets/backend.env");
});

it("enables the selected provider instance without copying local paths", () => {
  const settings = enableChildProvider(
    JSON.stringify({ providers: { codex: { enabled: true } } }),
    "cursor",
    "cursor_work",
  );
  const parsed = JSON.parse(settings) as {
    providers: Record<string, { enabled?: boolean }>;
    providerInstances: Record<
      string,
      {
        driver?: string;
        enabled?: boolean;
        environment?: Array<{ name: string; value: string }>;
      }
    >;
  };
  expect(parsed.providers.cursor?.enabled).toBe(true);
  expect(parsed.providerInstances.cursor_work).toMatchObject({ driver: "cursor", enabled: true });
  expect(parsed.providerInstances.cursor_work?.environment).toEqual([
    { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
    { name: "CURSOR_CONFIG_DIR", value: "/home/user/.config/cursor", sensitive: false },
    { name: "HOME", value: "/home/user", sensitive: false },
  ]);
  expect(settings).not.toContain("/Users/andrew");
});

it("uses the isolated Codex home instead of a copied manager account path", () => {
  const settings = JSON.parse(
    enableChildProvider(
      JSON.stringify({
        providerInstances: {
          codex_work: {
            homePath: "/Users/local/.codex",
            shadowHomePath: "/Users/local/.codex-work",
          },
        },
      }),
      "codex",
      "codex_work",
      "/private/operation/home",
    ),
  );
  expect(settings.providerInstances.codex_work).toMatchObject({
    homePath: "/private/operation/home/.codex",
    shadowHomePath: "",
  });
  expect(() => repositoryUrl("owner/repo/extra")).toThrow("owner/name");
});
