import { CommandExitError } from "e2b";
import { describe, expect, it } from "vite-plus/test";

import { e2bPythonResult } from "./E2bProvisionRuntime.ts";

describe("e2bPythonResult", () => {
  it("returns a successful command as python stdout/stderr", async () => {
    await expect(
      e2bPythonResult(Promise.resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: "" })),
    ).resolves.toEqual({ exitCode: 0, stdout: '{"ok":true}', stderr: "" });
  });

  it("unwraps CommandExitError so python stderr reaches prepareRemoteHost", async () => {
    await expect(
      e2bPythonResult(
        Promise.reject(
          new CommandExitError({
            exitCode: 1,
            stdout: "",
            stderr: "Remote preparation failed: Preparation command timed out: git fetch",
          }),
        ),
      ),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Remote preparation failed: Preparation command timed out: git fetch",
    });
  });

  it("rethrows transport failures that are not a command exit", async () => {
    await expect(e2bPythonResult(Promise.reject(new Error("sandbox gone")))).rejects.toThrow(
      "sandbox gone",
    );
  });
});
