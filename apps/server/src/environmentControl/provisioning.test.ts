import { expect, it } from "vite-plus/test";

import { repositoryUrl } from "./driver.ts";
import { ProvisionRefused } from "./ProvisioningProviderProfile.ts";

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
  const refusal = new ProvisionRefused({
    reason: "credentials",
    message: "No credentials for 'codex_x'.",
  });
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal.reason).toBe("credentials");
  expect(refusal.message).toContain("codex_x");
});

it("names a missing workspace file rather than provisioning a broken checkout", () => {
  // A configured file that is absent means the environment would come up
  // looking fine and fail the first time anything ran. Saying so beats
  // handing back an environment the caller has to debug.
  const refusal = new ProvisionRefused({
    reason: "unconfigured",
    message: "Workspace file '/secrets/backend.env' is configured but missing on this machine.",
  });
  expect(refusal.reason).toBe("unconfigured");
  expect(refusal.message).toContain("/secrets/backend.env");
});
