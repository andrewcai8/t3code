// @effect-diagnostics nodeBuiltinImport:off - login fixtures live in a temporary home.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveProvisioningProviderProfile } from "../../apps/server/src/environmentControl/ProvisioningProviderProfile.ts";
import { planManagerAccounts, type PlanInput } from "./provision-manager-accounts.ts";

const host: PlanInput["host"] = { homedir: "/Users/op", stateDir: "/Users/op/.t3/userdata" };
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
        codexLogin: { account: "codex" },
      },
      {
        source: "/Users/op/.codex_ac1/auth.json",
        destination: "/home/user/manager-state/codex-homes/codex_ac1/auth.json",
        codexLogin: { account: "codex_ac1" },
      },
      {
        source:
          "/Users/op/.t3/userdata/secrets/provider-auth-1708c8c8cb8bae5421c955c9031310df41eddd9f868172bd383a19ef2fdada72.bin",
        destination:
          "/home/user/manager-state/userdata/secrets/provider-auth-1708c8c8cb8bae5421c955c9031310df41eddd9f868172bd383a19ef2fdada72.bin",
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

  it.effect("puts the Cursor sign-in where the manager's own provisioning reads it", () =>
    Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plan-cursor-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
      );
      const plan = planManagerAccounts({
        settings,
        provisioning,
        host,
        managerBaseDir: base,
        accounts: ["cursor_work"],
      });
      const [carried] = plan.files;
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(carried!.destination), { recursive: true });
        await NodeFSP.writeFile(carried!.destination, "cursor-sign-in");
      });
      const profile = yield* resolveProvisioningProviderProfile(
        Schema.decodeUnknownSync(ServerSettings)({ providerInstances: plan.providerInstances }),
        { providerInstanceId: "cursor_work", agentDriver: "cursor" },
        undefined,
        {
          localAgentRuns: true,
          secretsDir: NodePath.join(base, "userdata", "secrets"),
          refresh: () => Effect.void,
        },
      );
      assert.deepEqual(profile.credential, {
        kind: "file",
        source: carried!.destination,
        destination: ".t3/userdata/provider-auth/cursor/cursor.json",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

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
        codexLogin: { account: "codex" },
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

  it("records a Claude account's email from its name when no local login names it", () => {
    const plan = planManagerAccounts({
      settings: {
        providerInstances: {
          claude_work: {
            driver: "claudeAgent",
            displayName: "Claude · work@example.com",
            enabled: true,
            config: { homePath: "/Users/op/.claude_missing" },
          },
        },
      },
      provisioning,
      host,
      managerBaseDir,
    });
    assert.deepEqual(plan.providerInstances.claude_work?.config, {
      accountEmail: "work@example.com",
    });
  });

  it("reads the default Claude account's email from home, whatever the packing shell's config dir", async () => {
    const homedir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plan-claude-"));
    try {
      const login = async (path: string, email: string) => {
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
        await NodeFSP.writeFile(path, JSON.stringify({ oauthAccount: { emailAddress: email } }));
      };
      await login(NodePath.join(homedir, ".claude.json"), "default@example.com");
      await login(NodePath.join(homedir, ".claude_work/.claude.json"), "work@example.com");
      const plan = planManagerAccounts({
        settings: { providerInstances: { claudeAgent: { driver: "claudeAgent", enabled: true } } },
        provisioning: { claudeOAuthTokens: { claudeAgent: "sk-ant-oat01-default" } },
        host: { homedir, stateDir: NodePath.join(homedir, ".t3/userdata") },
        managerBaseDir,
      });
      assert.deepEqual(plan.providerInstances.claudeAgent?.config, {
        accountEmail: "default@example.com",
      });
    } finally {
      await NodeFSP.rm(homedir, { recursive: true, force: true });
    }
  });

  it("records no email and warns when a Claude login and its name disagree, but records one they agree on", async () => {
    const homedir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-plan-claude-"));
    try {
      const login = async (directory: string, email: string) => {
        await NodeFSP.mkdir(NodePath.join(homedir, directory), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(homedir, directory, ".claude.json"),
          JSON.stringify({ oauthAccount: { emailAddress: email } }),
        );
      };
      await login(".claude_mixed", "other@example.com");
      await login(".claude_home", "Home@example.com");
      const account = (directory: string, email: string) => ({
        driver: "claudeAgent",
        displayName: `Claude · ${email}`,
        enabled: true,
        config: { homePath: NodePath.join(homedir, directory) },
      });
      const plan = planManagerAccounts({
        settings: {
          providerInstances: {
            claude_mixed: account(".claude_mixed", "mixed@example.com"),
            claude_home: account(".claude_home", "home@example.com"),
          },
        },
        provisioning: {
          claudeOAuthTokens: {
            claude_mixed: "sk-ant-oat01-mixed",
            claude_home: "sk-ant-oat01-home",
          },
        },
        host: { homedir, stateDir: NodePath.join(homedir, ".t3/userdata") },
        managerBaseDir,
      });
      assert.deepEqual(
        [plan.providerInstances.claude_mixed?.config, plan.providerInstances.claude_home?.config],
        [undefined, { accountEmail: "Home@example.com" }],
      );
      assert.deepEqual(plan.warnings, [
        "claude_mixed: its login is other@example.com but its name says mixed@example.com; recording no account email. Rename the instance or sign it in to the right account.",
      ]);
    } finally {
      await NodeFSP.rm(homedir, { recursive: true, force: true });
    }
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
        codexLogin: { account: "codex" },
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
