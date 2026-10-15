// @effect-diagnostics nodeBuiltinImport:off - bash replays what the copy's shell would run.
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "vite-plus/test";

import { exportsOf, parseForkExecArgs } from "./forkExec.ts";

const inBash = (script: string) =>
  NodeChildProcess.execFileSync("/bin/bash", ["-c", script], { env: {} }).toString();

it("hands the copy's shell a command and its arguments exactly as given", () => {
  const parsed = parseForkExecArgs([
    "--timeout",
    "600",
    "--",
    "printf",
    "%s|",
    "it's",
    "a b",
    "$HOME",
  ]);
  expect(parsed?.timeoutSeconds).toBe(600);
  expect(inBash(parsed!.command)).toBe("it's|a b|$HOME|");
  expect(parseForkExecArgs(["--", "echo one && echo two"])?.command).toBe("echo one && echo two");
  expect(parseForkExecArgs(["--"])).toBeNull();
});

it("recreates the caller's environment in the copy's shell", () => {
  const exports = exportsOf({
    FLAG: `a 'b' "c" $d`,
    EMPTY: "",
    PWD: "/elsewhere",
    "BAD-NAME": "x",
  });
  expect(inBash(`${exports}printf '%s|%s|%s' "$FLAG" "\${EMPTY-unset}" "\${BAD_NAME-unset}"`)).toBe(
    `a 'b' "c" $d||unset`,
  );
  expect(exports).not.toContain("PWD");
});
