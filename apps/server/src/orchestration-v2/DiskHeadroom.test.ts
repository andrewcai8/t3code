import { expect, it } from "vite-plus/test";

import { lowDiskNote } from "./DiskHeadroom.ts";

it("tells the agent how little disk is left once under 2 GB, and nothing above", () => {
  expect(lowDiskNote(5 * 1024 ** 3)).toBe("");
  expect(lowDiskNote(1.5 * 1024 ** 3)).toBe(
    "Note: this machine's disk is nearly full, with 1.5 GB free. Free space, such as build outputs or package caches, before writing large files; a full disk stops this chat from saving its work.",
  );
  expect(lowDiskNote(300 * 1024 ** 2)).toContain("with 300 MB free.");
});
