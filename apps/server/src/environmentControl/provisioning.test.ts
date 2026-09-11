import { expect, it } from "vite-plus/test";

import { ProvisionRefused, accountAuthPath, repositoryDirectory, repositoryUrl } from "./driver.ts";

it("reads each account's credentials from its own shadow home", () => {
  // Every entry in a shadow home except auth.json links back to the shared
  // one, so that file is the whole of an account's identity.
  expect(accountAuthPath("codex_ac3", "/home/a")).toBe("/home/a/.codex_ac3/auth.json");
});

it("leaves the default instance on the real Codex home", () => {
  expect(accountAuthPath("codex", "/home/a")).toBe("/home/a/.codex/auth.json");
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

it("checks a repository out under its own name", () => {
  expect(repositoryDirectory("Authentic-Intelligence/megpt-mono")).toBe(
    "/home/user/work/megpt-mono",
  );
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
