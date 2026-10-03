import { describe, expect, it } from "vite-plus/test";

import { cloneRepository } from "./repositoryClone.ts";

describe("cloneRepository", () => {
  it("names a fork's own remote rather than the upstream it targets", () => {
    expect(
      cloneRepository({
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "upstream",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        owner: "pingdotgg",
        name: "t3code",
        origin: {
          owner: "andrewcai8",
          name: "t3code",
          remoteUrl: "https://github.com/andrewcai8/t3code.git",
        },
      }),
    ).toBe("andrewcai8/t3code");
  });

  it("names the repository itself when it has no separate origin", () => {
    expect(
      cloneRepository({
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        owner: "pingdotgg",
        name: "t3code",
      }),
    ).toBe("pingdotgg/t3code");
    expect(cloneRepository(undefined)).toBeUndefined();
  });
});
