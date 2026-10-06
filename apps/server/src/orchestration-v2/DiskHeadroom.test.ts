import { expect, it } from "vite-plus/test";

import { lowDiskNote } from "./DiskHeadroom.ts";

it("tells the agent how much disk is left once under 10 GB, and nothing above", () => {
  expect(lowDiskNote(10.1 * 1024 ** 3)).toBe("");
  expect(lowDiskNote(9.9 * 1024 ** 3)).toBe(
    "Note: this machine's disk is running low, with 9.9 GB free. Remove worktrees, dependency installs and build outputs you created and no longer need before installing or writing more; a full disk stops this chat from saving its work.",
  );
  expect(lowDiskNote(300 * 1024 ** 2)).toContain("with 300 MB free.");
});
