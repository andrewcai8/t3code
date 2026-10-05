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

describe("connectionFloatingStatus for a waking cloud machine", () => {
  it("says what the machine is doing and how long it takes, in place of a reconnect", () => {
    const status = (
      connectionState: "reconnecting" | "waking" | "error",
      wake: { readonly title: string; readonly eta: string | null },
    ) =>
      connectionFloatingStatus({
        connectionError: null,
        connectionState,
        environmentLabel: "this chat's cloud machine",
        onReconnect: () => {},
        wake,
      })?.label;
    const sandbox = { title: "This chat's cloud machine is waking up", eta: "about 10 seconds" };
    expect(status("waking", sandbox)).toBe(
      "This chat's cloud machine is waking up, about 10 seconds...",
    );
    expect(
      status("reconnecting", { title: "This chat's cloud machine is updating", eta: null }),
    ).toBe("This chat's cloud machine is updating...");
    expect(status("error", sandbox)).toBe("Failed to connect to this chat's cloud machine");
  });
});
