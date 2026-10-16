import type { ProvisionProvider, VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CloudRunOn,
  cloudBaseRefs,
  cloudRunOnItems,
  cloudRunOnLabel,
  selectCloudRunOn,
  shouldOfferEnvironmentChoice,
} from "./CloudRunOn";

describe("shouldOfferEnvironmentChoice", () => {
  it("offers a choice between machines that already exist", () => {
    expect(
      shouldOfferEnvironmentChoice({
        environmentCount: 2,
        canChangeEnvironment: true,
        canCreateEnvironment: false,
      }),
    ).toBe(true);
  });

  it("offers a choice on a single machine when another can be created", () => {
    // Otherwise the first cloud machine can never be created from the place
    // machines are chosen: the control that would add one is hidden until one
    // has already been added.
    expect(
      shouldOfferEnvironmentChoice({
        environmentCount: 1,
        canChangeEnvironment: true,
        canCreateEnvironment: true,
      }),
    ).toBe(true);
  });

  it("stays quiet on a single machine with nothing to create", () => {
    expect(
      shouldOfferEnvironmentChoice({
        environmentCount: 1,
        canChangeEnvironment: true,
        canCreateEnvironment: false,
      }),
    ).toBe(false);
  });

  it("never offers a choice the composer cannot act on", () => {
    expect(
      shouldOfferEnvironmentChoice({
        environmentCount: 3,
        canChangeEnvironment: false,
        canCreateEnvironment: true,
      }),
    ).toBe(false);
  });
});

describe("cloudBaseRefs", () => {
  const ref = (name: string, remoteName?: string, isDefault = false): VcsRef => ({
    name,
    current: false,
    isDefault,
    worktreePath: null,
    isRemote: remoteName !== undefined,
    ...(remoteName ? { remoteName } : {}),
  });
  const refs = [
    ref("main", undefined, true),
    ref("local-only"),
    ref("origin/main", "origin", true),
    ref("origin/feature/x", "origin"),
    ref("upstream/release", "upstream"),
  ];
  const locator = (remoteName: string) => ({
    source: "git-remote" as const,
    remoteName,
    remoteUrl: `git@github.com:${remoteName}/repo.git`,
  });

  it("offers the cloned remote's branches by their remote names, never a local-only one", () => {
    const names = (identity: Parameters<typeof cloudBaseRefs>[1]) =>
      cloudBaseRefs(refs, identity).map((entry) => [entry.name, entry.isDefault]);
    expect(names({ canonicalKey: "github.com/me/repo", locator: locator("origin") })).toEqual([
      ["main", true],
      ["feature/x", false],
    ]);
    // A fork's identity names its upstream, but the cloud clones its origin.
    expect(
      names({
        canonicalKey: "github.com/them/repo",
        locator: locator("upstream"),
        origin: { canonicalKey: "github.com/me/repo", displayName: "me/repo" },
      }),
    ).toEqual([
      ["main", true],
      ["feature/x", false],
    ]);
    expect(names({ canonicalKey: "github.com/them/repo", locator: locator("upstream") })).toEqual([
      ["release", false],
    ]);
  });
});

describe("the Run-on picker's cloud entries", () => {
  const runOn = (providers: ReadonlyArray<ProvisionProvider>) => {
    const picked: ProvisionProvider[] = [];
    const cloudRunOn: CloudRunOn = {
      providers,
      onSelect: (provider) => picked.push(provider),
      creating: false,
      pending: null,
      base: undefined,
    };
    return { cloudRunOn, picked };
  };

  it("lists only the kinds the host offers, E2B first and Modal by its own name", () => {
    expect(cloudRunOnItems(runOn(["e2b", "modal"]).cloudRunOn).map(({ label }) => label)).toEqual([
      "E2B",
      "Modal",
    ]);
    expect(
      cloudRunOnItems(runOn(["e2b", "namespace"]).cloudRunOn).map(({ label }) => label),
    ).toEqual(["E2B", "Namespace Mac"]);
  });

  it("takes a pick of Modal as Modal, and refuses it where the host does not offer Modal", () => {
    const offered = runOn(["e2b", "modal"]);
    const [, modal] = cloudRunOnItems(offered.cloudRunOn);
    expect(selectCloudRunOn(offered.cloudRunOn, modal?.value)).toBe(true);
    expect(offered.picked).toEqual(["modal"]);
    expect(cloudRunOnLabel({ ...offered.cloudRunOn, pending: "modal" })).toBe("Modal");

    const notOffered = runOn(["e2b"]);
    expect(selectCloudRunOn(notOffered.cloudRunOn, modal?.value)).toBe(false);
    expect(notOffered.picked).toEqual([]);
  });
});
