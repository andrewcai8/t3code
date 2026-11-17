// @effect-diagnostics nodeBuiltinImport:off - the command runs in a real local shell.
import * as NodeChildProcess from "node:child_process";

import { expect, it } from "@effect/vitest";

import { commandOf } from "./e2bForkSandboxes.ts";

it("a command runs its argv and environment as given, whatever they hold", () => {
  const output = NodeChildProcess.execFileSync(
    "sh",
    [
      "-c",
      commandOf(["sh", "-c", 'printf "%s|%s|%s|%s" "$0" "$1" "$FOO" "$HOME"', "a b", "it's;$X"], {
        FOO: "x 'y' $Z",
        HOME: "/home/user",
      }),
    ],
    { encoding: "utf8" },
  );
  expect(output).toBe("a b|it's;$X|x 'y' $Z|/home/user");
});
