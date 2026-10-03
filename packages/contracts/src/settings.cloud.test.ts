import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("cloud machine cleanup settings", () => {
  it("removes unused cloud machines after a day by default", () => {
    expect(decodeServerSettings({}).storageCleanup.cloudMachinesAfterDays).toBe(1);
  });

  it("lets cloud machine cleanup be turned off or lengthened", () => {
    expect(
      decodeServerSettings({ storageCleanup: { cloudMachinesAfterDays: null } }).storageCleanup
        .cloudMachinesAfterDays,
    ).toBeNull();
    expect(decodeServerSettingsPatch({ storageCleanup: { cloudMachinesAfterDays: 30 } })).toEqual({
      storageCleanup: { cloudMachinesAfterDays: 30 },
    });
  });
});
