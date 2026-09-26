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
import { afterEach, beforeEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  resolvePreparation,
  resolveProvisioningProfiles,
  resolveProvisioningProviderProfile,
} from "./ProvisioningProviderProfile.ts";

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

  it.effect("reads Cursor credentials independently of its selected CLI config directory", () =>
    Effect.gen(function* () {
      const source = yield* file(cursorAuthRelative);
      yield* file("other-config/auth.json", "generic-account");
      const settings = decodeSettings({
        providerInstances: {
          selected: { driver: "cursor", enabled: true, environment: cursorEnvironment() },
        },
      });
      expect((yield* resolve(settings)).credential).toEqual({
        kind: "file",
        source,
        destination: ".cursor/auth.json",
      });
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
        const prepared = yield* Effect.promise(() => resolvePreparation(profile, {}, "e2b"));
        expect(prepared.environment).toContainEqual({
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: "sk-ant-oat01-cloud-only",
          sensitive: true,
        });
        expect(prepared.files).toEqual([]);
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
  ) =>
    resolveProvisioningProfiles(settings, { providerInstanceId, agentDriver }, claudeOAuthTokens, {
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
    }).pipe(
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
  const cursorMonthly = (usedPercent: number) => ({
    id: "cursor_monthly",
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
          cursor: [cursorMonthly(100)],
          cursorWork: [cursorMonthly(60)],
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
});

it.layer(NodeServices.layer)("Namespace preparation precedence", (it) => {
  it.effect("ignores missing overridden env sources while preserving independent variables", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          selected: {
            driver: "claudeAgent",
            environment: [
              { name: "ANTHROPIC_API_KEY", value: "selected-token", sensitive: true },
              { name: "ACCOUNT_LABEL", value: "selected-account", sensitive: false },
            ],
          },
        },
      });
      const profile = yield* resolve(settings);
      const independent = yield* file("independent", "independent-value\n");
      const missing = NodePath.join(directory, "missing");
      const prepared = yield* Effect.promise(() =>
        resolvePreparation(
          profile,
          {
            shellEnvironment: [
              { name: "ANTHROPIC_API_KEY", source: missing },
              { name: "ANTHROPIC_AUTH_TOKEN", source: missing },
              { name: "CURSOR_API_KEY", source: missing },
              { name: "ACCOUNT_LABEL", source: missing },
              { name: "PATH", source: missing },
              { name: "HOME", source: missing },
              { name: "INDEPENDENT", source: independent },
            ],
          },
          "namespace",
        ),
      );
      expect(prepared.environment).toContainEqual({
        name: "ANTHROPIC_API_KEY",
        value: "selected-token",
        sensitive: true,
      });
      expect(prepared.environment).toContainEqual({
        name: "ANTHROPIC_AUTH_TOKEN",
        value: "",
        sensitive: true,
      });
      expect(prepared.environment).toContainEqual({
        name: "ACCOUNT_LABEL",
        value: "selected-account",
        sensitive: false,
      });
      expect(prepared.environment).toContainEqual({
        name: "INDEPENDENT",
        value: "independent-value",
        sensitive: true,
      });
      // Another driver's login is not this account's to carry.
      expect(prepared.environment.map(({ name }) => name)).not.toContain("CURSOR_API_KEY");
      yield* Effect.promise(() =>
        expect(
          resolvePreparation(
            profile,
            {
              shellEnvironment: [{ name: "INDEPENDENT", source: missing }],
            },
            "namespace",
          ),
        ).rejects.toThrow("The source for INDEPENDENT could not be read."),
      );
    }),
  );
  it.effect(
    "deduplicates normalized destinations in favor of selected auth and preserves explicit account env",
    () =>
      Effect.gen(function* () {
        const source = yield* file(cursorAuthRelative);
        const genericToken = yield* file("token", "generic-token\n");
        const genericValue = yield* file("value", "  literal value \n\n");
        const settings = decodeSettings({
          providerInstances: {
            selected: {
              driver: "cursor",
              enabled: true,
              environment: [
                ...cursorEnvironment(),
                { name: "CUSTOM_ACCOUNT", value: "selected-account", sensitive: true },
              ],
            },
          },
        });
        const profile = yield* resolve(settings);
        const prepared = yield* Effect.promise(() =>
          resolvePreparation(
            profile,
            {
              homeFiles: [
                {
                  source: "/generic/auth.json",
                  destination: "/Users/runner/.cursor/./auth.json",
                },
              ],
              shellEnvironment: [
                { name: "CURSOR_API_KEY", source: genericToken },
                { name: "CUSTOM_ACCOUNT", source: genericToken },
                { name: "EXACT_BYTES", source: genericValue },
              ],
              namespace: { size: "m", prepareCommands: ["./prepare-native.sh"] },
            },
            "namespace",
          ),
        );
        expect(prepared.files).toEqual([{ source, destination: ".cursor/auth.json", mode: "600" }]);
        expect(prepared.environment).toContainEqual({
          name: "CURSOR_API_KEY",
          value: "",
          sensitive: true,
        });
        expect(prepared.environment).toContainEqual({
          name: "CUSTOM_ACCOUNT",
          value: "selected-account",
          sensitive: true,
        });
        expect(prepared.environment).toContainEqual({
          name: "EXACT_BYTES",
          value: "  literal value \n",
          sensitive: true,
        });
        expect(prepared.environment).toContainEqual({
          name: "CURSOR_CONFIG_DIR",
          value: "/Users/runner/.cursor",
          sensitive: false,
        });
        expect(prepared.prepareCommands).toEqual(["./prepare-native.sh"]);
      }),
  );

  it.effect("lets selected API auth override generic tokens without erasing it", () =>
    Effect.gen(function* () {
      const environment = [{ name: "ANTHROPIC_API_KEY", value: "selected-api", sensitive: true }];
      const settings = decodeSettings({
        providerInstances: { selected: { driver: "claudeAgent", environment } },
      });
      const profile = yield* resolve(settings);
      const generic = yield* file("generic", "generic-api");
      const prepared = yield* Effect.promise(() =>
        resolvePreparation(
          profile,
          {
            shellEnvironment: [{ name: "ANTHROPIC_API_KEY", source: generic }],
          },
          "namespace",
        ),
      );
      expect(prepared.environment.filter(({ name }) => name === "ANTHROPIC_API_KEY")).toEqual(
        environment,
      );
    }),
  );

  it.effect("rejects escaping destinations before transferring anything", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({
        providerInstances: {
          selected: {
            driver: "claudeAgent",
            environment: [{ name: "ANTHROPIC_API_KEY", value: "synthetic", sensitive: true }],
          },
        },
      });
      const profile = yield* resolve(settings);
      yield* Effect.promise(() =>
        expect(
          resolvePreparation(
            profile,
            {
              homeFiles: [{ source: "/source", destination: "../outside" }],
            },
            "namespace",
          ),
        ).rejects.toThrow("escapes"),
      );
    }),
  );
});

it.layer(NodeServices.layer)("shared preparation", (it) => {
  it.effect(
    "selects exact repository files and platform commands with explicit empty overrides",
    () =>
      Effect.gen(function* () {
        const source = yield* file("workspace.env");
        const profile = yield* resolve(
          decodeSettings({
            providerInstances: {
              selected: {
                driver: "claudeAgent",
                environment: [{ name: "ANTHROPIC_API_KEY", value: "selected", sensitive: true }],
              },
            },
          }),
        );
        const provisioning = {
          workspaceFiles: [{ source: "/missing-global", destination: "global.env" }],
          namespace: {
            size: "m",
            prepareCommands: ["global-prepare"],
            verifyCommands: ["global-verify"],
            artifacts: [{ path: "global", destination: ".cache", sha256: "a".repeat(64) }],
          },
          repositories: [
            {
              repository: "owner/name",
              workspaceFiles: [{ source, destination: ".env" }],
              e2b: { prepareCommands: ["linux-prepare"], verifyCommands: ["linux-verify"] },
              namespace: { prepareCommands: [], artifacts: [] },
            },
          ],
        };
        const linux = yield* Effect.promise(() =>
          resolvePreparation(profile, provisioning, "e2b", "https://github.com/OWNER/NAME.git"),
        );
        expect(linux.workspaceFiles).toEqual([{ source, destination: ".env" }]);
        expect(linux.prepareCommands).toEqual(["linux-prepare"]);
        expect(linux.verifyCommands).toEqual(["linux-verify"]);
        expect(linux.environment).toContainEqual({
          name: "CLAUDE_CONFIG_DIR",
          value: "/home/user/.claude",
          sensitive: false,
        });
        const mac = yield* Effect.promise(() =>
          resolvePreparation(profile, provisioning, "namespace", "owner/name"),
        );
        expect(mac.prepareCommands).toEqual([]);
        expect(mac.verifyCommands).toEqual(["global-verify"]);
        expect(mac.artifacts).toEqual([]);
        yield* Effect.promise(() =>
          expect(
            resolvePreparation(profile, provisioning, "e2b", "owner/namesake"),
          ).rejects.toThrow("missing-global"),
        );
        const empty = yield* Effect.promise(() =>
          resolvePreparation(
            profile,
            { ...provisioning, repositories: [{ repository: "owner/name", workspaceFiles: [] }] },
            "e2b",
            "owner/name",
          ),
        );
        expect(empty.workspaceFiles).toEqual([]);
      }),
  );
  it.effect(
    "uses selected Cursor credentials on Linux and ignores generic Claude files for API auth",
    () =>
      Effect.gen(function* () {
        const source = yield* file(cursorAuthRelative);
        const profile = yield* resolve(
          decodeSettings({
            providerInstances: {
              selected: { driver: "cursor", enabled: true, environment: cursorEnvironment() },
            },
          }),
        );
        const prepared = yield* Effect.promise(() =>
          resolvePreparation(
            profile,
            {
              homeFiles: [{ source: "/missing-generic", destination: ".config/cursor/auth.json" }],
            },
            "e2b",
          ),
        );
        expect(prepared.files).toEqual([
          { source, destination: ".config/cursor/auth.json", mode: "600" },
        ]);
        expect(prepared.environment).toContainEqual({
          name: "CURSOR_CONFIG_DIR",
          value: "/home/user/.config/cursor",
          sensitive: false,
        });
        const claude = yield* resolve(
          decodeSettings({
            providerInstances: {
              selected: {
                driver: "claudeAgent",
                environment: [{ name: "ANTHROPIC_API_KEY", value: "selected", sensitive: true }],
              },
            },
          }),
        );
        const api = yield* Effect.promise(() =>
          resolvePreparation(
            claude,
            {
              homeFiles: [
                { source: "/missing-other-account", destination: ".claude/.credentials.json" },
              ],
            },
            "e2b",
          ),
        );
        expect(api.files).toEqual([]);
      }),
  );
});
