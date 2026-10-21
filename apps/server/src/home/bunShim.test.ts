// @effect-diagnostics nodeBuiltinImport:off - the shim runs under the real /bin/sh against fake t3 and bun.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { reconcileBunShim } from "./bunShim.ts";

const OWNER = "/home/me/.t3";

const tempDir = (label: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3shim-${label}-`)));

const executable = (path: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text, { mode: 0o755 });
};

/** A script that logs its name and arguments, then exits with `$<exitVar>` (default 0). */
const recorder = (log: string, name: string, exitVar: string) =>
  `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit "\${${exitVar}:-0}"\n`;

describe("routing", () => {
  const home = tempDir("home");
  const bin = NodePath.join(home, ".local", "bin");
  const t3Home = NodePath.join(home, ".t3");
  const log = NodePath.join(home, "log");
  const suite = NodePath.join(home, "repo", "packages", "api");
  let server: NodeNet.Server;

  beforeAll(async () => {
    NodeFS.mkdirSync(t3Home, { recursive: true });
    NodeFS.mkdirSync(suite, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(suite, "a.test.ts"), "");
    executable(NodePath.join(bin, "bun"), "#!/bin/sh\necho user wrapper\n");
    executable(NodePath.join(bin, "t3"), recorder(log, "t3", "FAKE_T3_EXIT"));
    expect(reconcileBunShim(bin, OWNER, { skipWhenSet: ["MEGPT_HEAVY_SLOT"] })).toEqual([
      "moved_aside",
      "installed",
    ]);
    executable(NodePath.join(bin, ".bun.t3-real"), recorder(log, "real", "FAKE_BUN_EXIT"));
    server = NodeNet.createServer();
    await new Promise<void>((resolve) =>
      server.listen(NodePath.join(t3Home, "fork.sock"), resolve),
    );
  });
  afterAll(() => {
    server.close();
  });

  const bun = (args: ReadonlyArray<string>, env: Record<string, string | undefined> = {}) => {
    NodeFS.rmSync(log, { force: true });
    const result = NodeChildProcess.spawnSync("/bin/sh", [NodePath.join(bin, "bun"), ...args], {
      cwd: NodePath.join(home, "repo"),
      env: Object.fromEntries(
        Object.entries({
          PATH: `${bin}:/usr/bin:/bin`,
          T3CODE_HOME: t3Home,
          ...env,
        }).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      encoding: "utf8",
    });
    return {
      code: result.status,
      calls: NodeFS.existsSync(log) ? NodeFS.readFileSync(log, "utf8").trim().split("\n") : [],
    };
  };

  it.each([
    [["test"]],
    [["test", "packages/api"]],
    [["test", "--bail", "-t", "renders a row", "packages/api"]],
    [["test", "--shard=1/4", "--timeout", "30000"]],
    [["test", "--isolate", "--timeout", "60000", "packages/api"]],
    [["test", "--parallel=4", "--retry", "2", "--max-concurrency", "5", "--dots"]],
    [["test", "--only-failures", "--no-orphans", "--path-ignore-patterns=**/e2e/**"]],
  ])("sends a whole-suite run to fork-exec: bun %j", (args) => {
    expect(bun(args)).toEqual({ code: 0, calls: [`t3 fork-exec -- bun ${args.join(" ")}`] });
  });

  it.each([
    [["test", "packages/api/a.test.ts"]],
    [["test", "renders"]],
    [["test", "--watch"]],
    [["test", "-u"]],
    [["test", "--coverage"]],
    [["test", "--timeout"]],
    [["test", "--reporter=junit", "--reporter-outfile=junit.xml"]],
    [["test", "--coverage-dir=cov"]],
    [["test", "--timings=t.json", "--update-timings"]],
    [["test", "--changed"]],
    [["run", "test"]],
    [["install"]],
  ])("runs anything else with the real bun: bun %j", (args) => {
    expect(bun(args)).toEqual({ code: 0, calls: [`real ${args.join(" ")}`] });
  });

  it("stays local without an advertised socket, inside a skip variable, or without t3", () => {
    expect(bun(["test"], { T3CODE_HOME: undefined }).calls).toEqual(["real test"]);
    expect(bun(["test"], { T3CODE_HOME: home }).calls).toEqual(["real test"]);
    expect(bun(["test"], { MEGPT_HEAVY_SLOT: "1" }).calls).toEqual(["real test"]);
    expect(bun(["test"], { MEGPT_HEAVY_SLOT: "" }).calls).toEqual(["t3 fork-exec -- bun test"]);
    NodeFS.renameSync(NodePath.join(bin, "t3"), NodePath.join(bin, "t3.off"));
    try {
      expect(bun(["test"]).calls).toEqual(["real test"]);
    } finally {
      NodeFS.renameSync(NodePath.join(bin, "t3.off"), NodePath.join(bin, "t3"));
    }
  });

  it("runs the real bun when no copy started (75) and passes every other code through", () => {
    expect(bun(["test"], { FAKE_T3_EXIT: "75", FAKE_BUN_EXIT: "4" })).toEqual({
      code: 4,
      calls: ["t3 fork-exec -- bun test", "real test"],
    });
    for (const code of ["1", "70", "124"])
      expect(bun(["test"], { FAKE_T3_EXIT: code })).toEqual({
        code: Number(code),
        calls: ["t3 fork-exec -- bun test"],
      });
  });
});

describe("finding the real bun with nothing moved aside", () => {
  it("takes the first other bun on PATH, and exits 127 when there is none", () => {
    const home = tempDir("path");
    const bin = NodePath.join(home, ".local", "bin");
    const other = NodePath.join(home, "other");
    reconcileBunShim(bin, OWNER, { skipWhenSet: [] });
    executable(NodePath.join(other, "bun"), '#!/bin/sh\necho "other $*"\n');
    const run = (path: string) =>
      NodeChildProcess.spawnSync(NodePath.join(bin, "bun"), ["--version"], {
        env: { PATH: path },
        encoding: "utf8",
      });
    // The shim's own directory, spelled two ways, comes first and is skipped.
    expect(run(`${bin}/:${bin}:${other}:/usr/bin:/bin`).stdout).toBe("other --version\n");
    expect(run(`${bin}:/usr/bin:/bin`).status).toBe(127);
  });
});

describe("installing and removing", () => {
  const states = (bin: string) =>
    Object.fromEntries(
      ["bun", ".bun.t3-real"].map((name) => {
        const path = NodePath.join(bin, name);
        if (!NodeFS.existsSync(path)) return [name, null];
        const text = NodeFS.readFileSync(path, "utf8");
        return [name, text.includes("# t3-bun-shim 1") ? "shim" : text];
      }),
    );
  const binWith = (files: { readonly bun?: string; readonly real?: string }) => {
    const bin = NodePath.join(tempDir("bin"), ".local", "bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    if (files.bun !== undefined) executable(NodePath.join(bin, "bun"), files.bun);
    if (files.real !== undefined) executable(NodePath.join(bin, ".bun.t3-real"), files.real);
    return bin;
  };
  const users = '#!/bin/sh\nexec /usr/local/bin/bun "$@"\n';
  const install = { skipWhenSet: [] };

  it.each<
    [
      string,
      { readonly bun?: string; readonly real?: string },
      ReadonlyArray<string>,
      Record<string, string | null>,
    ]
  >([
    ["nothing there", {}, ["installed"], { bun: "shim", ".bun.t3-real": null }],
    [
      "the user's bun",
      { bun: users },
      ["moved_aside", "installed"],
      { bun: "shim", ".bun.t3-real": users },
    ],
    [
      "ours, with the user's moved aside",
      { real: users },
      ["installed"],
      { bun: "shim", ".bun.t3-real": users },
    ],
    [
      "two foreign files",
      { bun: users, real: "other\n" },
      ["conflict"],
      { bun: users, ".bun.t3-real": "other\n" },
    ],
  ])("install over %s", (_, files, changes, after) => {
    const bin = binWith(files);
    if (files.real !== undefined && files.bun === undefined) reconcileBunShim(bin, OWNER, install);
    expect(reconcileBunShim(bin, OWNER, install)).toEqual(changes);
    expect(states(bin)).toEqual(after);
  });

  it("an installed shim takes a new skip list on the next start", () => {
    const bin = binWith({});
    reconcileBunShim(bin, OWNER, { skipWhenSet: [] });
    reconcileBunShim(bin, OWNER, { skipWhenSet: ["MEGPT_HEAVY_SLOT"] });
    expect(NodeFS.readFileSync(NodePath.join(bin, "bun"), "utf8")).toContain("MEGPT_HEAVY_SLOT");
  });

  it.each([
    [
      "ours, with the user's moved aside",
      "shim+real",
      ["removed", "restored"],
      { bun: users, ".bun.t3-real": null },
    ],
    ["ours alone", "shim", ["removed"], { bun: null, ".bun.t3-real": null }],
    ["a crash between the two renames", "real", ["restored"], { bun: users, ".bun.t3-real": null }],
    ["the user's bun", "user", [], { bun: users, ".bun.t3-real": null }],
  ])("remove from %s", (_, start, changes, after) => {
    const bin = binWith(start === "user" ? { bun: users } : {});
    if (start.startsWith("shim")) reconcileBunShim(bin, OWNER, install);
    if (start.endsWith("real")) executable(NodePath.join(bin, ".bun.t3-real"), users);
    expect(reconcileBunShim(bin, OWNER, null)).toEqual(changes);
    expect(states(bin)).toEqual(after);
  });

  it("another T3 home without worktree forks leaves the shim and the bun behind it alone", () => {
    const bin = binWith({ bun: users });
    reconcileBunShim(bin, OWNER, install);
    expect(reconcileBunShim(bin, "/home/me/.t3/dev", null)).toEqual([]);
    expect(states(bin)).toEqual({ bun: "shim", ".bun.t3-real": users });
  });
});
