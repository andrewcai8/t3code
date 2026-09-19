import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  cloudMachineAccountOptions,
  cloudMachineBlockReason,
  cloudMachineRepositoryOptions,
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
      },
      {
        instanceId: ProviderInstanceId.make("cursor_andrewcai083"),
        driver: ProviderDriverKind.make("cursor"),
        label: "Cursor",
      },
    ]);
  });

  it("keeps a warning account, which runs fine and only has something to report", () => {
    const options = cloudMachineAccountOptions([
      provider({ instanceId: "codex_update", status: "warning" }),
    ]);

    expect(options.map((option) => option.instanceId)).toEqual(["codex_update"]);
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
