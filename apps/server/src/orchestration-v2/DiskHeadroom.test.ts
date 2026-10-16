// @effect-diagnostics nodeBuiltinImport:off - the test writes the setup failure log the note reads.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { expect, it } from "vite-plus/test";

import {
  cloudMachineNote,
  cloudMachineNoteFor,
  lowDiskNote,
  saveFailureNoteFor,
} from "./DiskHeadroom.ts";

it("tells a cloud box's agent how much disk is left once under 10 GB, and nothing above", () => {
  expect(lowDiskNote(10.1 * 1024 ** 3, true)).toBe("");
  expect(lowDiskNote(9.9 * 1024 ** 3, true)).toBe(
    "Note: this machine's disk is running low, with 9.9 GB free. Remove worktrees, dependency installs and build outputs you created and no longer need before installing or writing more; a full disk stops this chat from saving its work.",
  );
  expect(lowDiskNote(300 * 1024 ** 2, true)).toContain("with 300 MB free.");
});

it("waits until a user's own machine is under 2 GB", () => {
  expect(lowDiskNote(9.9 * 1024 ** 3, false)).toBe("");
  expect(lowDiskNote(2.1 * 1024 ** 3, false)).toBe("");
  expect(lowDiskNote(1.9 * 1024 ** 3, false)).toContain("with 1.9 GB free.");
});

const MACHINE =
  "Note: you are on a cloud machine used only by this chat (8 CPUs, 8 GB RAM, 50 GB disk).";
const FORK_EXEC =
  "Run whole-repo checks, full test suites and builds as `t3 fork-exec -- <command>`: the command runs in a throwaway copy of this machine with your uncommitted changes, and its output and exit code come back here while this machine stays fast. Don't create extra worktrees and installs here.";
const FORK_RUN =
  "To run several such jobs at once (test shards, eval replays), use t3_fork_run; their outputs go to S3 under outputsUri.";
const CLEANUP =
  "Keep large results in S3, not on this disk. Remove worktrees, installs and /tmp data you created once you no longer need them.";

it("points an E2B box's agents at fork-exec, its chats also at t3_fork_run, and a Mac box at S3", () => {
  const machine = { cpus: 8, memoryBytes: 7.8 * 1024 ** 3, diskBytes: 49.6 * 1024 ** 3 };
  expect(cloudMachineNote({ ...machine, forkExec: true, forkRun: true })).toBe(
    `${MACHINE} ${FORK_EXEC} ${FORK_RUN} ${CLEANUP}`,
  );
  expect(cloudMachineNote({ ...machine, forkExec: true, forkRun: false })).toBe(
    `${MACHINE} ${FORK_EXEC} ${CLEANUP}`,
  );
  expect(cloudMachineNote({ ...machine, forkExec: false, forkRun: true })).toBe(
    `${MACHINE} ${CLEANUP}`,
  );
});

const noteOn = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  turn: {
    readonly subagent?: boolean;
    readonly session?: object;
    readonly nativeThreadId?: string;
  } = {},
  mcpTools = true,
) =>
  cloudMachineNoteFor({
    cwd: NodeOS.tmpdir(),
    mcpTools,
    subagent: turn.subagent ?? false,
    session: turn.session ?? {},
    nativeThreadId: turn.nativeThreadId ?? "native-1",
  }).pipe(
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provideService(HostProcess.Platform, platform),
  );
const box = { T3CODE_USAGE_HOST_ID: "request-1" };
const forkSentence = "use t3_fork_run; their outputs go to S3";
const forkExecSentence = "as `t3 fork-exec -- <command>`";

effectIt.effect("tells a box's top-level chat on the first turn of each provider session", () =>
  Effect.gen(function* () {
    const session = {};
    const first = yield* noteOn(box, "linux", { session });
    expect(first).toMatch(/^Note: you are on a cloud machine used only by this chat \(\d+ CPUs, /);
    expect(first).toContain(forkSentence);
    expect(yield* noteOn(box, "linux", { session })).toBe("");
    expect(yield* noteOn(box, "linux", { session, nativeThreadId: "native-2" })).toBe(first);
    expect(yield* noteOn(box, "linux", { session: {} })).toBe(first);
  }),
);

effectIt.effect(
  "leaves a user's own machine alone and tells a box's subagents only fork-exec",
  () =>
    Effect.gen(function* () {
      expect(yield* noteOn(box, "linux")).toContain(forkSentence);
      expect(yield* noteOn({}, "linux")).toBe("");
      expect(yield* noteOn({ T3CODE_USAGE_HOST_ID: " " }, "linux")).toBe("");
      const subagent = yield* noteOn(box, "linux", { subagent: true });
      expect(subagent).toContain(forkExecSentence);
      expect(subagent).not.toContain("t3_fork_run");
    }),
);

effectIt.effect(
  "gives a Mac box's chat the note without forks, and a provider without MCP tools only fork-exec",
  () =>
    Effect.gen(function* () {
      const mac = yield* noteOn(box, "darwin");
      expect(mac).toMatch(
        /\. Keep large results in S3, not on this disk\. Remove worktrees, installs and \/tmp data you created once you no longer need them\.$/,
      );
      expect(mac).not.toContain("t3_fork_run");
      expect(mac).not.toContain("fork-exec");
      const withoutMcp = yield* noteOn(box, "linux", {}, false);
      expect(withoutMcp).toContain(forkExecSentence);
      expect(withoutMcp).not.toContain("t3_fork_run");
      expect(yield* noteOn(box, "linux")).toContain(forkSentence);
    }),
);

effectIt.effect("tells a box's chat when the project setup failed and where its output is", () =>
  Effect.gen(function* () {
    const t3home = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-setup-note-")),
    );
    const log = NodePath.join(t3home, "setup-failure.log");
    const onBox = { ...box, T3CODE_HOME: t3home };
    const healthy = yield* noteOn(onBox, "darwin");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        log,
        "Preparation command failed: missing MIND_BEDROCK_AUTH_URL\n$ node prepare.mjs\n\n",
      ),
    );
    expect(yield* noteOn(onBox, "darwin")).toBe(
      `${healthy} This machine's project setup failed when it was last prepared (Preparation command failed: missing MIND_BEDROCK_AUTH_URL), so dependencies or services it sets up may be missing. The failed commands and their output are in ${log}; fix the cause and rerun them.`,
    );
    yield* Effect.promise(() => NodeFSP.writeFile(log, `${"x".repeat(300)}\nmore\n`));
    expect(yield* noteOn(onBox, "darwin")).toContain(`(${"x".repeat(199)}…), so`);
    yield* Effect.promise(() => NodeFSP.rm(t3home, { recursive: true }));
  }),
);

effectIt.effect(
  "tells each thread once which paths keep its chat from saving, again when they change",
  () =>
    Effect.gen(function* () {
      const t3home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-save-note-")),
      );
      const failure = NodePath.join(t3home, "save-failure.json");
      const write = (largest: ReadonlyArray<readonly [string, number]>) =>
        Effect.promise(() =>
          NodeFSP.writeFile(
            failure,
            JSON.stringify({
              limit: 4 * 1024 ** 3,
              largest: largest.map(([path, bytes]) => ({ path, bytes })),
            }),
          ),
        );
      const noteFor = (
        thread: string,
        environment: NodeJS.ProcessEnv = { ...box, T3CODE_HOME: t3home },
      ) =>
        saveFailureNoteFor(thread).pipe(
          Effect.provideService(HostProcess.Environment, environment),
        );

      expect(yield* noteFor("native-1")).toBe("");
      yield* write([
        ["/root/home/fuzz/wt-fix3", 9.1 * 1024 ** 3],
        ["/root/home/.t3/baseline.tar.gz", 1.4 * 1024 ** 3],
      ]);
      expect(yield* noteFor("native-1")).toBe(
        "Note: this chat's work no longer fits in a save off this machine, which holds at most 4.0 GB. The largest saved paths are /root/home/fuzz/wt-fix3 (9.1 GB), /root/home/.t3/baseline.tar.gz (1.4 GB). Delete what you no longer need or move it to S3; dependency installs and build outputs in a checkout's ignored directories are not saved. Until a save fits, work since the last one is lost when this machine is replaced.",
      );
      expect(yield* noteFor("native-1"), "told once").toBe("");
      expect(yield* noteFor("native-2")).toContain("/root/home/fuzz/wt-fix3 (9.1 GB)");
      expect(yield* noteFor("native-3", { T3CODE_HOME: t3home }), "not a cloud box").toBe("");

      yield* write([["/root/home/.t3/baseline.tar.gz", 5 * 1024 ** 3]]);
      expect(yield* noteFor("native-1")).toContain(
        "The largest saved paths are /root/home/.t3/baseline.tar.gz (5.0 GB).",
      );
      yield* Effect.promise(() => NodeFSP.rm(failure));
      expect(yield* noteFor("native-1")).toBe("");
      yield* write([["/root/home/.t3/baseline.tar.gz", 5 * 1024 ** 3]]);
      expect(yield* noteFor("native-1"), "a new failure is news").toContain("baseline.tar.gz");
      yield* Effect.promise(() => NodeFSP.rm(t3home, { recursive: true }));
    }),
);
