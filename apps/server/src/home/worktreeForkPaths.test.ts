// @effect-diagnostics nodeBuiltinImport:off - the policy resolves real paths on this host.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { refusedPath } from "./worktreeForkPaths.ts";

const userHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-paths-"));
afterAll(() => NodeFS.rmSync(userHome, { recursive: true, force: true }));
// The home host's layout: managed worktrees live inside T3 home.
const t3Home = NodePath.join(userHome, ".t3");
const checkout = NodePath.join(t3Home, "worktrees", "repo", "branch");
NodeFS.mkdirSync(NodePath.join(t3Home, "userdata"), { recursive: true });
NodeFS.mkdirSync(checkout, { recursive: true });

describe("refusedPath with the job's checkout inside T3 home", () => {
  it("lets a job read and write inside its own checkout", () => {
    const runDir = NodePath.join(checkout, ".artifacts", "mind-twin", "run-1");
    expect(refusedPath(runDir, "output", t3Home, userHome, checkout)).toBeNull();
    expect(
      refusedPath(NodePath.join(checkout, "spec.json"), "input", t3Home, userHome, checkout),
    ).toBeNull();
  });

  it("still refuses T3's own state, and T3 home itself", () => {
    for (const path of [NodePath.join(t3Home, "userdata"), t3Home]) {
      expect(refusedPath(path, "output", t3Home, userHome, checkout)).toMatch(/T3 home/);
      expect(refusedPath(path, "input", t3Home, userHome, checkout)).toMatch(/T3 home/);
    }
  });

  it("refuses another worktree, and replacing the job's whole checkout", () => {
    const sibling = NodePath.join(t3Home, "worktrees", "repo", "other");
    expect(refusedPath(sibling, "output", t3Home, userHome, checkout)).toMatch(/T3 home/);
    expect(refusedPath(checkout, "output", t3Home, userHome, checkout)).toMatch(/whole checkout/);
  });

  it("refuses everything inside T3 home when no checkout is given", () => {
    const runDir = NodePath.join(checkout, ".artifacts");
    expect(refusedPath(runDir, "output", t3Home, userHome)).toMatch(/T3 home/);
  });
});
