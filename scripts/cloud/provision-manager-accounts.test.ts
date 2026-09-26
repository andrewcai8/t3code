import { assert, describe, it } from "@effect/vitest";

import { cursorFileCredentialPath } from "../../apps/server/src/provider/cursorCredentialPath.ts";
import { planManagerAccounts, type PlanInput } from "./provision-manager-accounts.ts";

const host: PlanInput["host"] = {
  homedir: "/Users/op",
  platform: "darwin",
  environment: { HOME: "/Users/op", XDG_CONFIG_HOME: "/Users/op/Library/Config" },
};
const managerBaseDir = "/home/user/manager-state";

const settings: PlanInput["settings"] = {
  providers: {},
  providerInstances: {
    codex: { driver: "codex", displayName: "Codex · default", enabled: true, environment: [] },
    codex_ac1: {
      driver: "codex",
      displayName: "Codex · ac1",
      enabled: true,
      config: {
        binaryPath: "/Users/op/.local/bin/codex",
        homePath: "/Users/op/.codex",
        shadowHomePath: "~/.codex_ac1",
      },
    },
    claude_work: {
      driver: "claudeAgent",
      displayName: "Claude · work",
      enabled: true,
      config: { binaryPath: "/opt/homebrew/bin/claude", homePath: "/Users/op/.claude_work" },
    },
    cursor_work: {
      driver: "cursor",
      displayName: "Cursor · work",
      enabled: true,
      environment: [
        { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
        {
          name: "HOME",
          value: "/Users/op/.t3/userdata/cursor-homes/cursor_work",
          sensitive: false,
        },
        {
          name: "CURSOR_CONFIG_DIR",
          value: "/Users/op/.t3/userdata/cursor-homes/cursor_work/.cursor",
          sensitive: false,
        },
      ],
      config: { binaryPath: "/Users/op/.local/bin/cursor-agent", apiEndpoint: "" },
    },
  },
};
const provisioning: PlanInput["provisioning"] = {
  claudeOAuthTokens: { claude_work: "sk-ant-oat01-work" },
  shellEnvironment: [
    { name: "CURSOR_API_KEY", source: "/Users/op/.t3/userdata/secrets/provider-env-cursor.bin" },
  ],
};

describe("planManagerAccounts", () => {
  it("carries every account, each where a Linux manager reads it", () => {
    const plan = planManagerAccounts({ settings, provisioning, host, managerBaseDir });

    assert.deepEqual(plan.accounts, ["codex", "codex_ac1", "claude_work", "cursor_work"]);
    // The legacy `claudeAgent` and `cursor` defaults exist on every install,
    // and here neither can travel.
    assert.deepEqual(plan.skipped, [
      {
        id: "claudeAgent",
        reason: "no provisioning.claudeOAuthTokens entry; run `claude setup-token` for it",
      },
      { id: "cursor", reason: "the account is disabled" },
    ]);
    assert.equal(plan.settingsPath, "/home/user/manager-state/userdata/settings.json");
    assert.deepEqual(plan.files, [
      {
        source: "/Users/op/.codex/auth.json",
        destination: "/home/user/manager-state/codex-homes/codex/auth.json",
        codexLogin: true,
      },
      {
        source: "/Users/op/.codex_ac1/auth.json",
        destination: "/home/user/manager-state/codex-homes/codex_ac1/auth.json",
        codexLogin: true,
      },
      {
        source: "/Users/op/.t3/userdata/cursor-homes/cursor_work/.cursor/auth.json",
        destination: "/home/user/manager-state/cursor-homes/cursor_work/.config/cursor/auth.json",
      },
      {
        source: "/Users/op/.t3/userdata/secrets/provider-env-cursor.bin",
        destination: "/home/user/manager-state/shell-environment/CURSOR_API_KEY",
      },
    ]);
    assert.deepEqual(plan.providerInstances, {
      codex: {
        driver: "codex",
        displayName: "Codex · default",
        enabled: true,
        config: { homePath: "/home/user/manager-state/codex-homes/codex" },
      },
      codex_ac1: {
        driver: "codex",
        displayName: "Codex · ac1",
        enabled: true,
        config: { homePath: "/home/user/manager-state/codex-homes/codex_ac1" },
      },
      claude_work: {
        driver: "claudeAgent",
        displayName: "Claude · work",
        enabled: true,
        environment: [
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-work", sensitive: true },
        ],
      },
      cursor_work: {
        driver: "cursor",
        displayName: "Cursor · work",
        enabled: true,
        environment: [
          {
            name: "HOME",
            value: "/home/user/manager-state/cursor-homes/cursor_work",
            sensitive: false,
          },
          {
            name: "XDG_CONFIG_HOME",
            value: "/home/user/manager-state/cursor-homes/cursor_work/.config",
            sensitive: false,
          },
          {
            name: "CURSOR_CONFIG_DIR",
            value: "/home/user/manager-state/cursor-homes/cursor_work/.config/cursor",
            sensitive: false,
          },
          { name: "AGENT_CLI_CREDENTIAL_STORE", value: "file", sensitive: false },
        ],
      },
    });
    assert.deepEqual(plan.shellEnvironment, [
      {
        name: "CURSOR_API_KEY",
        source: "/home/user/manager-state/shell-environment/CURSOR_API_KEY",
      },
    ]);
  });

  it("puts the Cursor file where the manager's own resolver looks, whatever its ambient env", () => {
    const plan = planManagerAccounts({ settings, provisioning, host, managerBaseDir });
    const environment: Record<string, string> = {
      HOME: "/home/user",
      XDG_CONFIG_HOME: "/home/user/.config",
    };
    for (const variable of plan.providerInstances.cursor_work?.environment ?? [])
      environment[variable.name] = variable.value;
    const credential = plan.files.find(({ destination }) => destination.includes("cursor-homes"));

    assert.equal(cursorFileCredentialPath(environment, "linux"), credential?.destination);
  });

  it("carries a Claude account as a token its instance runs on, and skips one without", () => {
    const plan = planManagerAccounts({
      settings: {
        providerInstances: {
          claude_work: { driver: "claudeAgent", enabled: true },
          claude_home: { driver: "claudeAgent", enabled: true },
        },
      },
      provisioning,
      host,
      managerBaseDir,
    });

    // `codex`, `claudeAgent` and `cursor` are the legacy defaults every install has.
    assert.deepEqual(plan.accounts, ["claude_work", "codex"]);
    assert.deepEqual(plan.skipped, [
      {
        id: "claude_home",
        reason: "no provisioning.claudeOAuthTokens entry; run `claude setup-token` for it",
      },
      {
        id: "claudeAgent",
        reason: "no provisioning.claudeOAuthTokens entry; run `claude setup-token` for it",
      },
      { id: "cursor", reason: "the account is disabled" },
    ]);
    assert.deepEqual(plan.files, [
      {
        source: "/Users/op/.codex/auth.json",
        destination: "/home/user/manager-state/codex-homes/codex/auth.json",
        codexLogin: true,
      },
      {
        source: "/Users/op/.t3/userdata/secrets/provider-env-cursor.bin",
        destination: "/home/user/manager-state/shell-environment/CURSOR_API_KEY",
      },
    ]);
    assert.deepEqual(plan.providerInstances.claude_work, {
      driver: "claudeAgent",
      enabled: true,
      environment: [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-work", sensitive: true },
      ],
    });
  });

  it("treats a built-in driver with no instance entry as the legacy default instance", () => {
    const plan = planManagerAccounts({
      settings: { providers: { codex: { enabled: true }, cursor: {} } },
      provisioning: {},
      host,
      managerBaseDir,
    });

    assert.deepEqual(plan.accounts, ["codex"]);
    assert.deepEqual(plan.files, [
      {
        source: "/Users/op/.codex/auth.json",
        destination: "/home/user/manager-state/codex-homes/codex/auth.json",
        codexLogin: true,
      },
    ]);
    assert.deepEqual(
      plan.skipped.map(({ id }) => id),
      ["claudeAgent", "cursor"],
    );
    assert.equal(plan.shellEnvironment, undefined);
  });

  it("skips disabled accounts and drivers that cannot provision", () => {
    const plan = planManagerAccounts({
      settings: {
        providerInstances: {
          codex: { driver: "codex", enabled: false },
          codex_off: { driver: "codex", config: { enabled: false } },
          grok: { driver: "grok", enabled: true },
          cursor: { driver: "cursor" },
          claudeAgent: { driver: "claudeAgent", enabled: false },
        },
      },
      provisioning: {},
      host,
      managerBaseDir,
    });

    assert.deepEqual(plan.accounts, []);
    assert.deepEqual(plan.skipped, [
      { id: "codex", reason: "the account is disabled" },
      { id: "codex_off", reason: "the account is disabled" },
      { id: "grok", reason: "the grok driver does not provision cloud environments" },
      { id: "cursor", reason: "the account is disabled" },
      { id: "claudeAgent", reason: "the account is disabled" },
    ]);
  });

  it("carries only the accounts asked for, and refuses one that cannot travel", () => {
    const plan = planManagerAccounts({
      settings,
      provisioning,
      host,
      managerBaseDir,
      accounts: ["cursor_work", "codex_ac1"],
    });

    assert.deepEqual(plan.accounts, ["codex_ac1", "cursor_work"]);
    assert.deepEqual(Object.keys(plan.providerInstances), ["codex_ac1", "cursor_work"]);
    assert.throws(
      () =>
        planManagerAccounts({ settings, provisioning, host, managerBaseDir, accounts: ["nope"] }),
      /Unknown provider account 'nope'/,
    );
    assert.throws(
      () =>
        planManagerAccounts({
          settings,
          provisioning: {},
          host,
          managerBaseDir,
          accounts: ["claude_work"],
        }),
      /'claude_work' cannot travel: no provisioning.claudeOAuthTokens entry/,
    );
  });

  it("refuses a shell variable whose name cannot be a file name", () => {
    assert.throws(
      () =>
        planManagerAccounts({
          settings,
          provisioning: { shellEnvironment: [{ name: "../etc", source: "/tmp/x" }] },
          host,
          managerBaseDir,
        }),
      /invalid variable/,
    );
  });
});
