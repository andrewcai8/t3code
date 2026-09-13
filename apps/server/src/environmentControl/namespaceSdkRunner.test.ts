import { describe, expect, it } from "vite-plus/test";
import { exposedOrigin, namespaceDestination, pairToken, shapeFor } from "./namespaceSdkRunner.ts";

describe("Namespace runner boundary parsing", () => {
  it("parses the workspace URL returned by devbox url expose", () => {
    expect(exposedOrigin('{"urls":[{"url":"https://dbx.devbox.so/"}]}')).toBe(
      "https://dbx.devbox.so",
    );
  });

  it("parses the one-time token returned by t3 pair", () => {
    expect(pairToken("\u001b[32mToken: ABC123\u001b[0m\n")).toBe("ABC123");
    expect(() => pairToken("no token")).toThrow("did not return a token");
  });

  it("maps the supported macOS sizes to their documented shapes", () => {
    expect(shapeFor("m")).toMatchObject({ virtualCpu: 6, memoryMegabytes: 14336 });
    expect(shapeFor("l")).toMatchObject({ virtualCpu: 12, memoryMegabytes: 28672 });
  });

  it("keeps transferred files inside the Namespace runner home", () => {
    expect(namespaceDestination(".config/cursor/auth.json")).toBe(
      "/Users/runner/.config/cursor/auth.json",
    );
    expect(() => namespaceDestination("../../etc/passwd")).toThrow("escapes");
  });
});
