import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  cloudMachineAccountDetail,
  cloudMachineAccountOptions,
  cloudMachineBlockReason,
  cloudMachineRepositoryOptions,
  defaultCloudMachineAccount,
  defaultCloudMachineRepository,
} from "./cloudMachineOptions";

function project(title: string, owner?: string, name?: string) {
  return {
    title,
    ...(owner && name
      ? { repositoryIdentity: { owner, name } as never }
      : { repositoryIdentity: null }),
  };
}

function provider(
  input: Omit<Partial<ServerProvider>, "instanceId"> & { readonly instanceId: string },
): ServerProvider {
  return {
    ...input,
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver ?? ProviderDriverKind.make("codex"),
    status: input.status ?? "ready",
    displayName: input.displayName ?? null,
  } as ServerProvider;
}

describe("cloudMachineRepositoryOptions", () => {
  it("collapses projects that clone the same repository into one choice", () => {
    const options = cloudMachineRepositoryOptions([
      project("t3code", "pingdotgg", "t3code"),
      project("t3code worktree", "pingdotgg", "t3code"),
      project("notes", "andrewcai8", "notes"),
    ]);

    expect(options).toEqual([
      { repository: "andrewcai8/notes", projectTitles: ["notes"] },
      { repository: "pingdotgg/t3code", projectTitles: ["t3code", "t3code worktree"] },
    ]);
  });

  it("drops projects with no repository, which a machine could not clone", () => {
    expect(cloudMachineRepositoryOptions([project("scratch")])).toEqual([]);
  });

  it("keeps a repeated project title once", () => {
    const options = cloudMachineRepositoryOptions([
      project("t3code", "pingdotgg", "t3code"),
      project("t3code", "pingdotgg", "t3code"),
    ]);

    expect(options).toEqual([{ repository: "pingdotgg/t3code", projectTitles: ["t3code"] }]);
  });
});

describe("cloudMachineAccountOptions", () => {
  it("drops accounts that cannot run here, since the guest signs in as the same account", () => {
    const options = cloudMachineAccountOptions([
      provider({ instanceId: "codex_andrewca78", displayName: "Codex · andrewca78" }),
      provider({ instanceId: "codex_broken", status: "error" }),
      provider({ instanceId: "codex_off", status: "disabled" }),
      provider({
        instanceId: "cursor_andrewcai083",
        driver: ProviderDriverKind.make("cursor"),
        displayName: "Cursor",
      }),
    ]);

    expect(options).toEqual([
      {
        instanceId: ProviderInstanceId.make("codex_andrewca78"),
        driver: ProviderDriverKind.make("codex"),
        label: "Codex · andrewca78",
        usedPercent: null,
      },
      {
        instanceId: ProviderInstanceId.make("cursor_andrewcai083"),
        driver: ProviderDriverKind.make("cursor"),
        label: "Cursor",
        usedPercent: null,
      },
    ]);
  });

  it("keeps a warning account, which runs fine and only has something to report", () => {
    const options = cloudMachineAccountOptions([
      provider({ instanceId: "codex_update", status: "warning" }),
    ]);

    expect(options.map((option) => option.instanceId)).toEqual(["codex_update"]);
  });

  it("reports the tightest window, since that is what stops the guest working", () => {
    const options = cloudMachineAccountOptions([
      provider({
        instanceId: "codex",
        usageLimits: {
          checkedAt: "2026-09-20T00:00:00.000Z",
          windows: [
            { id: "session", kind: "session", label: "Session", usedPercent: 12 },
            { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 98 },
          ],
        },
      } as never),
    ]);

    expect(options[0]?.usedPercent).toBe(98);
  });

  it("reports nothing for an account whose usage could not be read", () => {
    const options = cloudMachineAccountOptions([
      provider({
        instanceId: "cursor",
        usageLimits: {
          checkedAt: "2026-09-20T00:00:00.000Z",
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 50 }],
          unavailable: { reason: "probeFailed" },
        },
      } as never),
    ]);

    expect(options[0]?.usedPercent).toBeNull();
  });

  it("falls back to the instance id when an account has no display name", () => {
    expect(cloudMachineAccountOptions([provider({ instanceId: "codex" })])[0]?.label).toBe("codex");
  });
});

describe("cloudMachineBlockReason", () => {
  const account = {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    label: "Codex",
    usedPercent: null,
  };

  it("blocks with no account", () => {
    expect(cloudMachineBlockReason({ repository: "a/b", provider: "e2b", account: null })).toBe(
      "Connect a provider account first.",
    );
  });

  it("blocks with no repository, because the phone cannot add a checkout later", () => {
    expect(cloudMachineBlockReason({ repository: null, provider: "e2b", account })).toBe(
      "Choose a repository to clone.",
    );
  });

  it("allows a complete selection", () => {
    expect(
      cloudMachineBlockReason({ repository: "a/b", provider: "namespace", account }),
    ).toBeNull();
  });
});

describe("defaultCloudMachineAccount", () => {
  const option = (instanceId: string, usedPercent: number | null) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    label: instanceId,
    usedPercent,
  });

  it("starts on the account with the most headroom, not the first one configured", () => {
    const chosen = defaultCloudMachineAccount([
      option("codex_ac1", 100),
      option("codex_andrewca78", 37),
      option("codex_andrewcai083", 98),
    ]);

    expect(chosen?.instanceId).toBe("codex_andrewca78");
  });

  it("prefers a measured account over one that reports nothing", () => {
    const chosen = defaultCloudMachineAccount([option("cursor", null), option("codex", 99)]);

    expect(chosen?.instanceId).toBe("codex");
  });

  it("falls back to the first account when none report usage", () => {
    const chosen = defaultCloudMachineAccount([option("a", null), option("b", null)]);

    expect(chosen?.instanceId).toBe("a");
  });

  it("has nothing to choose with no accounts", () => {
    expect(defaultCloudMachineAccount([])).toBeNull();
  });
});

describe("cloudMachineAccountDetail", () => {
  it("reports usage when the account knows it", () => {
    expect(
      cloudMachineAccountDetail({
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        label: "Codex",
        usedPercent: 98.4,
      }),
    ).toBe("98% used");
  });

  it("says nothing when the account cannot report usage", () => {
    expect(
      cloudMachineAccountDetail({
        instanceId: ProviderInstanceId.make("cursor"),
        driver: ProviderDriverKind.make("cursor"),
        label: "Cursor",
        usedPercent: null,
      }),
    ).toBeNull();
  });
});

describe("defaultCloudMachineRepository", () => {
  it("selects the only repository, which is not a choice", () => {
    expect(defaultCloudMachineRepository([{ repository: "a/b", projectTitles: ["b"] }])).toBe(
      "a/b",
    );
  });

  it("picks none when there is more than one, since no default is defensible", () => {
    expect(
      defaultCloudMachineRepository([
        { repository: "a/b", projectTitles: ["b"] },
        { repository: "c/d", projectTitles: ["d"] },
      ]),
    ).toBeNull();
  });

  it("picks none when there are no repositories", () => {
    expect(defaultCloudMachineRepository([])).toBeNull();
  });
});
