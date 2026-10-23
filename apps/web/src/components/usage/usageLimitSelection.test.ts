import type { EnvironmentPresentationWithProviders } from "@t3tools/client-runtime/state/presentation";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectLimitPresentations } from "./usageLimitSelection";

const live = EnvironmentId.make("live");
const paused = EnvironmentId.make("paused");

function presentation(phase: string, withConfig = true): EnvironmentPresentationWithProviders {
  return {
    connection: { phase },
    serverConfig: withConfig
      ? {
          providers: [{ driver: "claudeAgent" }, { driver: "codex" }],
          usageLimitSources: [
            { accounts: [{ driver: "claudeAgent" }] },
            { accounts: [{ driver: "codex" }] },
          ],
        }
      : null,
  } as unknown as EnvironmentPresentationWithProviders;
}

const drivers = (selected: ReturnType<typeof selectLimitPresentations>, id: EnvironmentId) =>
  selected.get(id)?.serverConfig?.providers.map((provider) => provider.driver);

describe("selectLimitPresentations", () => {
  it("keeps connected environments and drops disconnected ones with their sources", () => {
    const selected = selectLimitPresentations(
      new Map([
        [live, presentation("connected")],
        [paused, presentation("disconnected")],
      ]),
      null,
      new Set(),
    );
    expect([...selected.keys()]).toEqual([live]);
    expect(selected.get(live)?.serverConfig?.usageLimitSources).toHaveLength(2);
  });

  it("drops every environment when none is connected", () => {
    const selected = selectLimitPresentations(
      new Map([
        [live, presentation("connecting")],
        [paused, presentation("disconnected")],
      ]),
      null,
      new Set(),
    );
    expect(selected.size).toBe(0);
  });

  it("drops connected environments that have no config yet", () => {
    const selected = selectLimitPresentations(
      new Map([[live, presentation("connected", false)]]),
      null,
      new Set(),
    );
    expect(selected.size).toBe(0);
  });

  it("still applies the environment selection", () => {
    const other = EnvironmentId.make("other");
    const selected = selectLimitPresentations(
      new Map([
        [live, presentation("connected")],
        [other, presentation("connected")],
      ]),
      new Set([other]),
      new Set(),
    );
    expect([...selected.keys()]).toEqual([other]);
  });

  it("still filters hidden drivers from providers and sources", () => {
    const selected = selectLimitPresentations(
      new Map([[live, presentation("connected")]]),
      null,
      new Set(["codex" as never]),
    );
    expect(drivers(selected, live)).toEqual(["claudeAgent"]);
    expect(selected.get(live)?.serverConfig?.usageLimitSources).toEqual([
      { accounts: [{ driver: "claudeAgent" }] },
    ]);
  });
});
