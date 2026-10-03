import { describe, expect, it } from "vite-plus/test";

import { connectionFloatingStatus } from "./floating-working-status";

describe("connectionFloatingStatus for a cloud box", () => {
  it("names a cloud box by its role in every phase, never by its stale machine label", () => {
    const status = (connectionState: "reconnecting" | "waking") =>
      connectionFloatingStatus({
        connectionError: null,
        connectionState,
        environmentLabel: "this chat's cloud machine",
        onReconnect: () => {},
      });
    expect(status("reconnecting")).toMatchObject({
      label: "Reconnecting to this chat's cloud machine...",
    });
    expect(status("waking")).toMatchObject({
      tone: "reconnecting",
      label: "This chat's cloud machine is waking up...",
    });
  });
});
