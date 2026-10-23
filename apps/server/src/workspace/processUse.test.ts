import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import { makeProcessUseProbe } from "./processUse.ts";

const lsofOutput = (stdout: string, code: number) =>
  ({
    stdout,
    stderr: "",
    code,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  }) as unknown as ProcessRunner.ProcessRunOutput;

const probeWith = (result: ProcessRunner.ProcessRunOutput, root: string) =>
  Effect.gen(function* () {
    const probe = yield* makeProcessUseProbe;
    return yield* probe(root);
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, {
      run: () => Effect.succeed(result),
    }),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provide(NodeServices.layer),
  );

describe("macOS process probe", () => {
  const self = `p${process.pid}\nn/somewhere/else\n`;

  it.effect("answers unknown, not free, when lsof exits 1 with nothing listed", () =>
    Effect.gen(function* () {
      expect(yield* probeWith(lsofOutput("", 1), "/work/tree")).toMatchObject({
        status: "unknown",
      });
    }),
  );

  it.effect("answers unknown when lsof lists processes but not the server itself", () =>
    Effect.gen(function* () {
      expect(yield* probeWith(lsofOutput("p1\nn/elsewhere\n", 0), "/work/tree")).toMatchObject({
        status: "unknown",
      });
    }),
  );

  it.effect("answers unknown when lsof fails", () =>
    Effect.gen(function* () {
      expect(yield* probeWith(lsofOutput(self, 2), "/work/tree")).toMatchObject({
        status: "unknown",
      });
    }),
  );

  it.effect("answers free once lsof has listed the server's own process", () =>
    Effect.gen(function* () {
      expect(yield* probeWith(lsofOutput(self, 1), "/work/tree")).toEqual({ status: "free" });
    }),
  );

  it.effect("finds a process inside the folder even when lsof exits 1", () =>
    Effect.gen(function* () {
      expect(
        yield* probeWith(lsofOutput(`${self}p4242\nn/work/tree/sub\n`, 1), "/work/tree"),
      ).toEqual({ status: "busy", pid: 4242 });
      expect(
        yield* probeWith(lsofOutput(`${self}p4243\nn/work/tree-other\n`, 0), "/work/tree"),
      ).toEqual({ status: "free" });
    }),
  );
});
