// @effect-diagnostics nodeBuiltinImport:off - builds a real scratch tree for the synchronous sweep.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import { sweepCheckpointScratch } from "./checkpointScratch.ts";

it("a restart clears this pid's directory and dead pids', and leaves live servers' alone", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-sweep-"));
  const own = process.pid;
  const live = process.ppid;
  // Above the kernel's pid limit, so no process can hold it.
  const dead = 2 ** 31 - 2;
  for (const name of [own, live, dead, "notes"]) {
    NodeFS.mkdirSync(NodePath.join(root, String(name)));
    NodeFS.writeFileSync(NodePath.join(root, String(name), "t3-checkpoint-index-x"), "");
  }

  sweepCheckpointScratch(root, own);

  assert.deepStrictEqual(NodeFS.readdirSync(root).toSorted(), [String(live), "notes"].toSorted());
  NodeFS.rmSync(root, { recursive: true, force: true });
});
