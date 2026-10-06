// @effect-diagnostics nodeBuiltinImport:off - account fixtures use isolated temporary homes.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderInstanceId,
  ServerSettings,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Option from "effect/Option";
import {
  resolveProvisioningProfiles,
  resolveProvisioningProviderProfile,
  resolveSwitchProfile,
} from "./ProvisioningProviderProfile.ts";
import { credentialSecretName } from "../provider/providerCredentialName.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);
let directory: string;
const cursorAuthRelative =
  HostProcessPlatform.defaultValue() === "win32"
    ? "AppData/Roaming/Cursor/auth.json"
    : HostProcessPlatform.defaultValue() === "darwin"
      ? ".cursor/auth.json"
      : ".config/cursor/auth.json";
const cursorEnvironment = () => [
  { name: "HOME", value: directory, sensitive: false },
  { name: "USERPROFILE", value: directory, sensitive: false },
  { name: "APPDATA", value: NodePath.join(directory, "AppData/Roaming"), sensitive: false },
  { name: "XDG_CONFIG_HOME", value: NodePath.join(directory, ".config"), sensitive: false },
  { name: "CURSOR_CONFIG_DIR", value: NodePath.join(directory, "other-config"), sensitive: false },
];
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-provision-profile-"));
});
afterEach(async () => {
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

const file = (relative: string, value = "synthetic-auth") =>
  Effect.promise(async () => {
    const path = NodePath.join(directory, relative);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, value);
    return path;
  });

/** A host's own login whose refresh failed: past expiry, with a refresh token Codex holds. */
const revokedHostLogin = JSON.stringify({
  tokens: {
    id_token: "eyJ.id.sig",
    access_token: `eyJhbGciOiJSUzI1NiJ9.${Buffer.from('{"exp":1788433200}').toString("base64url")}.sig`,
    refresh_token: "rt_revoked",
    account_id: "acct-1",
  },
});

function resolve(settings: ServerSettings, providerInstanceId = "selected", agentDriver?: string) {
  return resolveProvisioningProviderProfile(settings, { providerInstanceId, agentDriver });
}

it.layer(NodeServices.layer)("selected provisioning account", (it) => {
  it.effect(
    "uses the current Codex shadow auth instead of the shared or guessed account home",
    () =>
      Effect.gen(function* () {
        yield* file("shared/auth.json", "shared-account");
        const selected = yield* file("shadow/auth.json", "selected-account");
        const settings = decodeSettings({
          providerInstances: {
            selected: {
              driver: "codex",
              config: {
                homePath: NodePath.join(directory, "shared"),
                shadowHomePath: NodePath.join(directory, "shadow"),
              },
            },
          },
        });
        expect((yield* resolve(settings)).credential).toEqual({
          kind: "file",
          source: selected,
          destination: ".codex/auth.json",
        });
        const changed = decodeSettings({
          providerInstances: {
            selected: { driver: "codex", config: { homePath: NodePath.join(directory, "shared") } },
          },
        });
        expect((yield* resolve(changed)).credential).toEqual({
          kind: "file",
          source: NodePath.join(directory, "shared/auth.json"),
          destination: ".codex/auth.json",
        });
      }),
  );

  it.effect("carries the selected account's display name, omitting it when unset", () =>
    Effect.gen(function* () {
      const source = yield* file("named/auth.json");
      const settings = decodeSettings({
        providerInstances: {
          selected: {
            driver: "codex",
            displayName: "Codex · andrewcai083@gmail.com",
            config: { homePath: NodePath.dirname(source) },
          },
        },
      });
      expect((yield* resolve(settings)).displayName).toBe("Codex · andrewcai083@gmail.com");
      const unnamed = decodeSettings({
        providerInstances: {
          selected: { driver: "codex", config: { homePath: NodePath.dirname(source) } },
        },
      });
      expect((yield* resolve(unnamed)).displayName).toBeUndefined();
    }),
  );

  it.effect("resolves a legacy default account from its configured Codex home", () =>
    Effect.gen(function* () {
      const source = yield* file("custom/auth.json");
      const settings = decodeSettings({
        providers: { codex: { homePath: NodePath.dirname(source) } },
      });
      expect((yield* resolve(settings, "codex")).credential).toEqual({
        kind: "file",
        source,
        destination: ".codex/auth.json",
      });
    }),
  );

  it.effect("refuses a managed ChatGPT Codex account instead of copying the home's auth.json", () =>
    Effect.gen(function* () {
      const source = yield* file("managed/auth.json", "unrelated-cli-login");
      const settings = decodeSettings({
        providerInstances: {
          selected: {
            driver: "codex",
            config: { setupMode: "managed", homePath: NodePath.dirname(source) },
          },
        },
      });
      expect((yield* Effect.flip(resolve(settings))).message).toBe(
        "This Codex account signs in with ChatGPT through T3 Code, which cloud machines can't use. Pick a Codex account signed in with the Codex CLI.",
      );
    }),
  );

  it.effect("requires selected Codex file auth even when API environment is configured", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          selected: {
            driver: "codex",
            config: { homePath: directory },
            environment: [{ name: "OPENAI_API_KEY", value: "synthetic", sensitive: true }],
          },
        },
      });
      expect((yield* Effect.flip(resolve(settings))).message).toContain("could not be found");
      const source = yield* file("auth.json");
      expect((yield* resolve(settings)).credential).toEqual({
        kind: "file",
        source,
        destination: ".codex/auth.json",
      });
    }),
  );

  it.effect("sends a Cursor account the sign-in this server keeps in its secret store", () =>
    Effect.gen(function* () {
      yield* file(cursorAuthRelative, "cursor-agent-login");
      const source = yield* file(
        `secrets/${credentialSecretName("cursor", "selected")}.bin`,
        '{"version":1,"backendUrl":"https://api2.cursor.sh","apiKey":"key","createdAtMs":1}',
      );
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "cursor", enabled: true, environment: cursorEnvironment() },
        },
      });
      const profile = yield* resolveProvisioningProviderProfile(
        settings,
        { providerInstanceId: "selected" },
        undefined,
        {
          localAgentRuns: false,
          secretsDir: NodePath.join(directory, "secrets"),
          refresh: () => Effect.void,
        },
      );
      expect(profile.credential).toEqual({
        kind: "file",
        source,
        destination: ".t3/userdata/provider-auth/cursor/cursor.json",
      });
      expect((yield* Effect.flip(resolve(settings, "selected", "cursor"))).message).toBe(
        "The selected account credentials could not be found on this machine.",
      );
    }),
  );

  it.effect("copies portable Claude credentials from the configured directory itself", () =>
    Effect.gen(function* () {
      const source = yield* file("claude/.credentials.json");
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "claudeAgent", config: { homePath: NodePath.dirname(source) } },
        },
      });
      expect((yield* resolve(settings)).credential).toEqual({
        kind: "file",
        source,
        destination: ".claude/.credentials.json",
      });
    }),
  );

  it.effect("keeps explicit Claude token auth without requiring a portable file", () =>
    Effect.gen(function* () {
      const environment = [
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "selected-synthetic-token", sensitive: true },
      ];
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "claudeAgent", config: { homePath: directory }, environment },
        },
      });
      expect(yield* resolve(settings)).toEqual({
        kind: "claudeAgent",
        instanceId: "selected",
        credential: { kind: "environment" },
        environment,
      });
    }),
  );

  it.effect("refuses keychain-only Claude accounts with the command that makes them portable", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "claudeAgent", config: { homePath: directory } },
        },
      });
      expect((yield* Effect.flip(resolve(settings))).message).toBe(
        `This Claude account stores its login in the macOS keychain, which can't be copied safely. Run \`CLAUDE_CONFIG_DIR=${directory} claude setup-token\` and add the token under provisioning.claudeOAuthTokens.selected in environment-control.json.`,
      );
    }),
  );

  it.effect(
    "starts a keychain-only Claude account in the cloud with its configured setup-token",
    () =>
      Effect.gen(function* () {
        const settings = decodeSettings({
          providerInstances: {
            selected: { driver: "claudeAgent", config: { homePath: directory } },
          },
        });
        const profile = yield* resolveProvisioningProviderProfile(
          settings,
          { providerInstanceId: "selected" },
          { selected: "sk-ant-oat01-cloud-only" },
        );
        expect(profile.environment).toContainEqual({
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: "sk-ant-oat01-cloud-only",
          sensitive: true,
        });
        expect(profile.credential).toEqual({ kind: "environment" });
      }),
  );

  it.effect("refuses stale driver selection and disabled accounts", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "codex", enabled: false, config: { homePath: directory } },
        },
      });
      expect((yield* Effect.flip(resolve(settings, "selected", "cursor"))).message).toContain(
        "unavailable",
      );
      expect((yield* Effect.flip(resolve(settings))).message).toContain("disabled");
      expect((yield* Effect.flip(resolve(settings, "missing"))).message).toContain("unavailable");
    }),
  );
});

it.layer(NodeServices.layer)("provisioned accounts", (it) => {
  const accounts = (
    settings: ServerSettings,
    providerInstanceId = "selected",
    claudeOAuthTokens?: Record<string, string>,
    usage: Record<string, ReadonlyArray<ServerProviderUsageWindow>> = {},
    agentDriver?: string,
    active: Record<string, number> = {},
    pinAccount = false,
  ) =>
    resolveProvisioningProfiles(
      settings,
      { providerInstanceId, agentDriver, pinAccount },
      claudeOAuthTokens,
      {
        providers: Object.entries(usage).map(([instanceId, windows]) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          usageLimits: { checkedAt: "2026-09-03T11:55:00.000Z", windows },
        })),
        now: Date.parse("2026-09-03T12:00:00.000Z"),
        load: new Map(
          Object.entries(active).map(([instanceId, count]) => [
            ProviderInstanceId.make(instanceId),
            count,
          ]),
        ),
      },
    ).pipe(
      Effect.map((profiles) =>
        profiles.map(({ kind, instanceId, credential }) => [kind, instanceId, credential.kind]),
      ),
    );

  it.effect("brings every driver's default account along with the selected one", () =>
    Effect.gen(function* () {
      const codex = yield* file("codex/auth.json");
      const settings = decodeSettings({
        providers: { codex: { homePath: NodePath.dirname(codex) } },
        providerInstances: {
          selected: { driver: "claudeAgent", config: { homePath: directory } },
          cursor: {
            driver: "cursor",
            enabled: true,
            environment: [{ name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true }],
          },
        },
      });
      expect(
        yield* accounts(settings, "selected", { selected: "sk-ant-oat01-cloud-only" }),
      ).toEqual([
        ["claudeAgent", "selected", "environment"],
        ["codex", "codex", "file"],
        ["cursor", "cursor", "environment"],
      ]);
    }),
  );

  it.effect("leaves off a driver whose default account cannot be provisioned", () =>
    Effect.gen(function* () {
      yield* file("codex/auth.json");
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "codex", config: { homePath: NodePath.join(directory, "codex") } },
          claudeAgent: { driver: "claudeAgent", config: { homePath: directory } },
          cursor: { driver: "cursor", enabled: false },
        },
      });
      expect(yield* accounts(settings)).toEqual([["codex", "selected", "file"]]);
    }),
  );

  const session = (usedPercent: number) => ({
    id: "five_hour",
    kind: "session" as const,
    label: "Session",
    usedPercent,
    resetsAt: "2026-09-03T14:00:00.000Z",
  });
  const weekly = (usedPercent: number) => ({
    id: "seven_day",
    kind: "weekly" as const,
    label: "Weekly",
    usedPercent,
    resetsAt: "2026-09-07T00:00:00.000Z",
  });
  const cursorOverall = (usedPercent: number) => ({
    id: "totalPercentUsed",
    kind: "monthly" as const,
    label: "Monthly",
    usedPercent,
    resetsAt: "2026-10-01T00:00:00.000Z",
  });
  const apiKeyAccount = (driver: string, name: string, value: string) => ({
    driver,
    enabled: true,
    environment: [{ name, value, sensitive: true }],
  });
  const routedSettings = () =>
    decodeSettings({
      providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
      providerInstances: {
        selected: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "selected-key"),
        claudeSpare: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "spare-key"),
        cursor: { driver: "cursor", enabled: false },
        cursorWork: apiKeyAccount("cursor", "CURSOR_API_KEY", "work-key"),
        cursorHome: apiKeyAccount("cursor", "CURSOR_API_KEY", "home-key"),
      },
    });

  it.effect("runs the chat and each companion on the account with the most usage left", () =>
    Effect.gen(function* () {
      expect(
        yield* accounts(routedSettings(), "selected", undefined, {
          selected: [session(20), weekly(97)],
          claudeSpare: [session(80), weekly(10)],
          cursorWork: [session(60)],
          cursorHome: [session(10)],
        }),
      ).toEqual([
        ["claudeAgent", "claudeSpare", "environment"],
        ["cursor", "cursorHome", "environment"],
      ]);
    }),
  );

  it.effect("keeps a pinned chat on its account while companions still route by usage", () =>
    Effect.gen(function* () {
      expect(
        yield* accounts(
          routedSettings(),
          "selected",
          undefined,
          {
            selected: [session(20), weekly(97)],
            claudeSpare: [session(80), weekly(10)],
            cursorWork: [session(60)],
            cursorHome: [session(10)],
          },
          "claudeAgent",
          {},
          true,
        ),
      ).toEqual([
        ["claudeAgent", "selected", "environment"],
        ["cursor", "cursorHome", "environment"],
      ]);
    }),
  );

  it.effect("refuses a pinned account that is over its limit instead of routing around it", () =>
    Effect.gen(function* () {
      const refused = yield* Effect.flip(
        accounts(
          routedSettings(),
          "selected",
          undefined,
          { selected: [session(100), weekly(40)], claudeSpare: [session(10)] },
          "claudeAgent",
          {},
          true,
        ),
      );
      expect([refused.reason, refused.message]).toEqual([
        "credentials",
        "selected is over its usage limit.",
      ]);
    }),
  );

  it.effect("moves the chat and each companion off accounts that are already busy", () =>
    Effect.gen(function* () {
      expect(
        yield* accounts(
          routedSettings(),
          "selected",
          undefined,
          { selected: [session(40)], claudeSpare: [session(70)] },
          undefined,
          { selected: 2, cursorHome: 1 },
        ),
      ).toEqual([
        ["claudeAgent", "claudeSpare", "environment"],
        ["cursor", "cursorWork", "environment"],
      ]);
    }),
  );

  it.effect("hands the routed Claude account's email to the box", () =>
    Effect.gen(function* () {
      const tokenAccount = (token: string, accountEmail: string) => ({
        driver: "claudeAgent",
        enabled: true,
        environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: token, sensitive: true }],
        config: { accountEmail },
      });
      const profiles = yield* resolveProvisioningProfiles(
        decodeSettings({
          providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
          providerInstances: {
            claude_work: tokenAccount("sk-ant-oat01-work", "work@example.com"),
            claude_home: tokenAccount("sk-ant-oat01-home", "home@example.com"),
          },
        }),
        { providerInstanceId: "claude_work", agentDriver: "claudeAgent" },
        undefined,
        {
          providers: [
            {
              instanceId: ProviderInstanceId.make("claude_work"),
              usageLimits: { checkedAt: "2026-09-03T11:55:00.000Z", windows: [session(90)] },
            },
            {
              instanceId: ProviderInstanceId.make("claude_home"),
              usageLimits: { checkedAt: "2026-09-03T11:55:00.000Z", windows: [session(10)] },
            },
          ],
          now: Date.parse("2026-09-03T12:00:00.000Z"),
        },
      );
      expect(profiles.map(({ instanceId, accountEmail }) => [instanceId, accountEmail])).toEqual([
        ["claude_home", "home@example.com"],
      ]);
    }),
  );

  it.effect("counts a busy account's sessions on every instance that shares its email", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
        providerInstances: {
          work: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "work-key"),
          workAgain: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "work-key-2"),
          home: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "home-key"),
        },
      });
      const reading = (instanceId: string, email: string, usedPercent: number) => ({
        instanceId: ProviderInstanceId.make(instanceId),
        auth: { status: "authenticated" as const, email },
        usageLimits: { checkedAt: "2026-09-03T11:55:00.000Z", windows: [session(usedPercent)] },
      });
      const profiles = yield* resolveProvisioningProfiles(
        settings,
        { providerInstanceId: "work", agentDriver: "claudeAgent" },
        undefined,
        {
          providers: [
            reading("work", "work@example.com", 20),
            reading("workAgain", "work@example.com", 20),
            reading("home", "home@example.com", 50),
          ],
          now: Date.parse("2026-09-03T12:00:00.000Z"),
          load: new Map([[ProviderInstanceId.make("work"), 3]]),
        },
      );
      expect(profiles.map(({ instanceId }) => instanceId)).toEqual(["home"]);
    }),
  );

  it.effect("gives a Claude chat's Codex and Cursor companions their best accounts", () =>
    Effect.gen(function* () {
      yield* file("codex-default/auth.json", "default-login");
      yield* file("codex-spare/auth.json", "spare-login");
      const settings = decodeSettings({
        providers: {
          claudeAgent: { enabled: false },
          codex: { homePath: NodePath.join(directory, "codex-default") },
        },
        providerInstances: {
          selected: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "selected-key"),
          codex_ac1: {
            driver: "codex",
            config: { homePath: NodePath.join(directory, "codex-spare") },
          },
          cursor: apiKeyAccount("cursor", "CURSOR_API_KEY", "default-key"),
          cursorWork: apiKeyAccount("cursor", "CURSOR_API_KEY", "work-key"),
        },
      });
      const exhaustedDefaults = yield* accounts(
        settings,
        "claudeAgent",
        undefined,
        {
          selected: [session(10)],
          codex: [session(100)],
          codex_ac1: [session(30)],
          cursor: [cursorOverall(100)],
          cursorWork: [cursorOverall(60)],
        },
        "claudeAgent",
      );
      // Unknown usage everywhere: the defaults already carry a box's companions.
      const busyDefaults = yield* accounts(settings, "claudeAgent", undefined, {}, "claudeAgent", {
        codex: 1,
        cursor: 1,
      });
      expect([exhaustedDefaults, busyDefaults]).toEqual([
        [
          ["claudeAgent", "selected", "environment"],
          ["codex", "codex_ac1", "file"],
          ["cursor", "cursorWork", "environment"],
        ],
        [
          ["claudeAgent", "selected", "environment"],
          ["codex", "codex_ac1", "file"],
          ["cursor", "cursorWork", "environment"],
        ],
      ]);
    }),
  );

  it.effect("skips a Codex account whose copied login would expire, however much room it has", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-03T12:00:00.000Z"));
      const codexLogin = (exp: number) =>
        JSON.stringify({
          tokens: {
            id_token: "eyJ.id.sig",
            access_token: `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(`{"exp":${exp}}`).toString("base64url")}.sig`,
            refresh_token: "t3-copy-cannot-refresh",
            account_id: "acct-1",
          },
        });
      yield* file("codex-roomy/auth.json", codexLogin(1788433200));
      yield* file("codex-spare/auth.json", codexLogin(1789041600));
      const settings = (spareHome: string) =>
        decodeSettings({
          providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
          providerInstances: {
            roomy: {
              driver: "codex",
              displayName: "Codex · roomy",
              config: { homePath: NodePath.join(directory, "codex-roomy") },
            },
            spare: { driver: "codex", config: { homePath: NodePath.join(directory, spareHome) } },
            cursor: { driver: "cursor", enabled: false },
          },
        });
      const usage = { roomy: [session(5)], spare: [session(90)] };
      const expired = "Codex · roomy's Codex login expired; sign in on your computer and reseed.";
      expect(yield* accounts(settings("codex-spare"), "roomy", undefined, usage)).toEqual([
        ["codex", "spare", "file"],
      ]);
      expect((yield* Effect.flip(resolve(settings("codex-spare"), "roomy", "codex"))).message).toBe(
        expired,
      );
      expect(
        (yield* Effect.flip(accounts(settings("codex-roomy"), "roomy", undefined, usage))).message,
      ).toBe(expired);
    }),
  );

  it.effect("refuses a host's own Codex login that stays expired after a refresh", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-03T12:00:00.000Z"));
      yield* file("codex-host/auth.json", revokedHostLogin);
      const settings = decodeSettings({
        providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
        providerInstances: {
          codex_uci: {
            driver: "codex",
            config: { homePath: NodePath.join(directory, "codex-host") },
          },
          cursor: { driver: "cursor", enabled: false },
        },
      });
      const refreshed: Array<string> = [];
      const failure = yield* Effect.flip(
        resolveProvisioningProviderProfile(
          settings,
          { providerInstanceId: "codex_uci", agentDriver: "codex" },
          undefined,
          {
            localAgentRuns: false,
            secretsDir: NodePath.join(directory, "secrets"),
            refresh: (instanceId) => Effect.sync(() => void refreshed.push(instanceId)),
          },
        ),
      );
      expect([refreshed, failure.message]).toEqual([
        ["codex_uci"],
        "codex_uci's Codex login on this host expired; sign in again with ~/.t3/provisioning/codex-site-login.sh and reseed.",
      ]);
    }),
  );

  it.effect("keeps the hinted account when no account reports usage", () =>
    Effect.gen(function* () {
      expect(yield* accounts(routedSettings(), "selected")).toEqual([
        ["claudeAgent", "selected", "environment"],
        ["cursor", "cursorHome", "environment"],
      ]);
    }),
  );

  it.effect("falls through to the next account when the best login is not portable", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
        providerInstances: {
          selected: apiKeyAccount("claudeAgent", "ANTHROPIC_API_KEY", "selected-key"),
          keychain: { driver: "claudeAgent", config: { homePath: directory } },
          cursor: { driver: "cursor", enabled: false },
        },
      });
      expect(
        yield* accounts(
          settings,
          "selected",
          undefined,
          { keychain: [session(0)], selected: [session(90)] },
          "claudeAgent",
        ),
      ).toEqual([["claudeAgent", "selected", "environment"]]);
    }),
  );

  it.effect("still refuses when the selected account cannot be provisioned", () =>
    Effect.gen(function* () {
      yield* file("codex/auth.json");
      const settings = decodeSettings({
        providers: { codex: { homePath: NodePath.join(directory, "codex") } },
        providerInstances: {
          selected: { driver: "claudeAgent", config: { homePath: directory } },
          cursor: { driver: "cursor", enabled: false },
        },
      });
      expect((yield* Effect.flip(accounts(settings))).message).toBe(
        `This Claude account stores its login in the macOS keychain, which can't be copied safely. Run \`CLAUDE_CONFIG_DIR=${directory} claude setup-token\` and add the token under provisioning.claudeOAuthTokens.selected in environment-control.json.`,
      );
    }),
  );

  describe("the account a cloud box switches to", () => {
    const token = (name: string) => ({
      driver: "claudeAgent",
      enabled: true,
      environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: `${name}-token`, sensitive: true }],
    });
    const settings = decodeSettings({
      providers: { claudeAgent: { enabled: false } },
      providerInstances: {
        claude_work: token("work"),
        claude_spare: token("spare"),
        claude_roomy: token("roomy"),
        claude_twin: token("twin"),
      },
    });
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const reading = (instanceId: string, usedPercent: number, email: string) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      auth: { status: "authenticated" as const, email },
      usageLimits: {
        checkedAt: "2026-10-06T11:45:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session" as const,
            label: "Session",
            usedPercent,
            resetsAt: "2026-10-06T15:00:00.000Z",
          },
        ],
      },
    });
    const switchFrom = (
      exclude: ReadonlyArray<string>,
      providers: ReadonlyArray<ReturnType<typeof reading>>,
    ) =>
      resolveSwitchProfile(
        settings,
        { driver: "claudeAgent", exclude: new Set(exclude) },
        undefined,
        { providers, now },
      ).pipe(Effect.map(Option.map((profile) => profile.instanceId)));

    it.effect("takes the account with the most left, past the one that hit its limit", () =>
      Effect.gen(function* () {
        // The work account still reads as roomy: its reading predates the limit it just hit.
        const providers = [
          reading("claude_work", 10, "work@example.com"),
          reading("claude_spare", 60, "spare@example.com"),
          reading("claude_roomy", 20, "roomy@example.com"),
          reading("claude_twin", 0, "work@example.com"),
        ];
        expect(yield* switchFrom(["claude_work"], providers)).toEqual(Option.some("claude_roomy"));
      }),
    );

    it.effect("skips spent accounts, and finds none once every other one is spent", () =>
      Effect.gen(function* () {
        const providers = [
          reading("claude_work", 100, "work@example.com"),
          reading("claude_spare", 100, "spare@example.com"),
          reading("claude_roomy", 30, "roomy@example.com"),
          reading("claude_twin", 100, "twin@example.com"),
        ];
        expect(yield* switchFrom(["claude_work"], providers)).toEqual(Option.some("claude_roomy"));
        expect(yield* switchFrom(["claude_work", "claude_roomy"], providers)).toEqual(
          Option.none(),
        );
      }),
    );
  });
});
