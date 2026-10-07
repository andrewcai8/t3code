import * as NodeOS from "node:os";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { expect, it } from "vite-plus/test";

import { cloudMachineNote, cloudMachineNoteFor, lowDiskNote } from "./DiskHeadroom.ts";

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

const E2B_NOTE =
  "Note: you are on a cloud machine used only by this chat (8 CPUs, 8 GB RAM, 50 GB disk). For parallel or heavy jobs (eval replays, test shards, separate builds) use t3_fork_run: each job runs in a throwaway copy of this machine and its outputs go to S3 under outputsUri. Don't create extra worktrees and installs here. Keep large results in S3, not on this disk.";

it("points an E2B box's chat at forks and S3, and a Mac box's chat only at S3", () => {
  const machine = { cpus: 8, memoryBytes: 7.8 * 1024 ** 3, diskBytes: 49.6 * 1024 ** 3 };
  expect(cloudMachineNote({ ...machine, forks: true })).toBe(E2B_NOTE);
  expect(cloudMachineNote({ ...machine, forks: false })).toBe(
    "Note: you are on a cloud machine used only by this chat (8 CPUs, 8 GB RAM, 50 GB disk). Keep large results in S3, not on this disk.",
  );
});

const noteOn = (
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  thread: { readonly subagent: boolean; readonly nativeThreadHasTurns: boolean },
) =>
  cloudMachineNoteFor({ cwd: NodeOS.tmpdir(), ...thread }).pipe(
    Effect.provideService(HostProcessEnvironment, environment),
    Effect.provideService(HostProcessPlatform, platform),
  );
const box = { T3CODE_USAGE_HOST_ID: "request-1" };
const firstTurn = { subagent: false, nativeThreadHasTurns: false };
const forkSentence = "use t3_fork_run: each job runs in a throwaway copy of this machine";

effectIt.effect("tells a box's top-level chat once per native conversation", () =>
  Effect.gen(function* () {
    const first = yield* noteOn(box, "linux", firstTurn);
    expect(first).toMatch(/^Note: you are on a cloud machine used only by this chat \(\d+ CPUs, /);
    expect(first).toContain(forkSentence);
    expect(yield* noteOn(box, "linux", { subagent: false, nativeThreadHasTurns: true })).toBe("");
  }),
);

effectIt.effect("leaves a user's own machine and a box's subagents alone", () =>
  Effect.gen(function* () {
    expect(yield* noteOn(box, "linux", firstTurn)).toContain(forkSentence);
    expect(yield* noteOn({}, "linux", firstTurn)).toBe("");
    expect(yield* noteOn({ T3CODE_USAGE_HOST_ID: " " }, "linux", firstTurn)).toBe("");
    expect(yield* noteOn(box, "linux", { subagent: true, nativeThreadHasTurns: false })).toBe("");
  }),
);

effectIt.effect("gives a Mac box's chat the note without forks", () =>
  Effect.gen(function* () {
    const mac = yield* noteOn(box, "darwin", firstTurn);
    expect(mac).toMatch(/\. Keep large results in S3, not on this disk\.$/);
    expect(mac).not.toContain("t3_fork_run");
    expect(yield* noteOn(box, "linux", firstTurn)).toContain(forkSentence);
  }),
);
