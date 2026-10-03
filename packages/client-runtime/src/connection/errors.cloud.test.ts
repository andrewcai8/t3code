import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";

describe("mapRemoteEnvironmentError", () => {
  it.each([404, 502, 503])("reads an undeclared %i as a box that is not serving yet", (status) => {
    expect(
      mapRemoteEnvironmentError(
        new RemoteEnvironmentAuthUndeclaredStatusError("https://box.example.test/", status),
      ),
    ).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "not-serving",
      detail: `Remote environment endpoint https://box.example.test/ returned undeclared status ${status}.`,
    });
  });

  it("keeps an undeclared 500 a remote failure", () => {
    expect(
      mapRemoteEnvironmentError(
        new RemoteEnvironmentAuthUndeclaredStatusError("https://box.example.test/", 500),
      ),
    ).toMatchObject({ _tag: "ConnectionTransientError", reason: "remote-unavailable" });
  });
});
