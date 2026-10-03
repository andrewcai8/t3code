import { assert, it } from "@effect/vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { autoBootstrapModelSelection } from "./autoBootstrapModelSelection.ts";
import { getAutoBootstrapThreadModelSelection } from "./serverRuntimeStartup.ts";

it("uses the canonical Codex model for auto-bootstrap when Codex is enabled", () => {
  assert.deepEqual(
    autoBootstrapModelSelection(DEFAULT_SERVER_SETTINGS, getAutoBootstrapThreadModelSelection()),
    { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
  );
});

it("bootstraps a provisioned box on the one provider it enabled", () => {
  const claudeOnlySettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
    },
  };
  assert.deepEqual(
    autoBootstrapModelSelection(claudeOnlySettings, getAutoBootstrapThreadModelSelection()),
    {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make("claudeAgent")]!,
    },
  );
});
