import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "../providerInstances";
import { cloudProviderEntries } from "./cloudProviderEntries";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
  accentColor?: string;
  status?: ServerProvider["status"];
  auth?: ServerProvider["auth"];
  message?: string;
  models?: ServerProvider["models"];
  supportsTextGeneration?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: input.supportsTextGeneration }),
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: input.auth ?? { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...(input.message ? { message: input.message } : {}),
    models: input.models ?? [],
    slashCommands: [],
    skills: [],
  };
}

const model = (slug: string, isCustom = false, isDefault = false) => ({
  slug,
  name: slug,
  isCustom,
  ...(isDefault ? { isDefault: true } : {}),
  capabilities: {},
});

describe("cloudProviderEntries", () => {
  it("offers one driver-labeled row per cloud driver, hinting a ready account", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_work",
        displayName: "Work",
        accentColor: "#ff0000",
        models: [model("claude-work-model")],
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        models: [model("claude-default-model")],
      }),
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex",
        status: "error",
      }),
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: "codex_personal",
      }),
      provider({
        provider: ProviderDriverKind.make("cursor"),
        instanceId: "cursor",
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("opencode"), instanceId: "opencode" }),
    ]);

    expect(
      cloudProviderEntries(entries).map((entry) => ({
        instanceId: entry.instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        models: entry.models.map((option) => option.slug),
      })),
    ).toEqual([
      {
        instanceId: "claudeAgent",
        displayName: "Claude",
        accentColor: undefined,
        models: ["claude-default-model"],
      },
      { instanceId: "codex_personal", displayName: "Codex", accentColor: undefined, models: [] },
    ]);
  });

  it("offers a driver whose every account's host probe timed out", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const discoveryTimedOut = "Cursor ACP model discovery timed out after 15000ms.";
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: cursor,
        instanceId: "cursor",
        status: "warning",
        message: discoveryTimedOut,
        models: [model("default", false, true), model("gpt-5.5")],
      }),
      provider({
        provider: cursor,
        instanceId: "cursor_acai13",
        status: "warning",
        message: discoveryTimedOut,
        models: [model("default", false, true), model("gpt-5.5")],
      }),
      provider({
        provider: cursor,
        instanceId: "cursor_andrewcai083",
        status: "error",
        auth: { status: "unknown" },
        message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
        models: [model("default", false, true), model("gpt-5.5")],
      }),
    ]);

    expect(
      cloudProviderEntries(entries).map((entry) => ({
        instanceId: entry.instanceId,
        displayName: entry.displayName,
        pickerReady: isProviderInstancePickerReady(entry),
        models: entry.models.map((option) => option.slug),
      })),
    ).toEqual([
      {
        instanceId: "cursor",
        displayName: "Cursor",
        pickerReady: true,
        models: ["default", "gpt-5.5"],
      },
    ]);
  });

  it("hints a ready account over a default whose probe timed out", () => {
    const cursor = ProviderDriverKind.make("cursor");
    const entries = deriveProviderInstanceEntries([
      provider({ provider: cursor, instanceId: "cursor", status: "warning" }),
      provider({ provider: cursor, instanceId: "cursor_work" }),
    ]);

    expect(cloudProviderEntries(entries).map((entry) => entry.instanceId)).toEqual(["cursor_work"]);
  });

  it("keeps a driver whose every account is signed out unready, with its reason", () => {
    const entries = deriveProviderInstanceEntries([
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claudeAgent",
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude is not signed in.",
      }),
    ]);

    expect(
      cloudProviderEntries(entries).map((entry) => ({
        pickerReady: isProviderInstancePickerReady(entry),
        message: entry.snapshot.message,
      })),
    ).toEqual([{ pickerReady: false, message: "Claude is not signed in." }]);
  });
});
