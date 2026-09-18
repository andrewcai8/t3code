import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderInstanceDisplayName } from "./providerInstanceDisplay.ts";

const codex = ProviderDriverKind.make("codex");

describe("resolveProviderInstanceDisplayName", () => {
  it("keeps a name that differs from the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
        displayName: "Work",
      }),
    ).toBe("Work");
  });

  it("humanizes a custom instance id when the name only carries the brand label", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex_personal"),
        driver: codex,
        displayName: "Codex",
      }),
    ).toBe("Codex Personal");
  });

  it("uses the brand label for the default instance", () => {
    expect(
      resolveProviderInstanceDisplayName({
        instanceId: ProviderInstanceId.make("codex"),
        driver: codex,
      }),
    ).toBe("Codex");
  });
});
