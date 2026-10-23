// @effect-diagnostics nodeBuiltinImport:off - real git repositories and a real sh play host and copy.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import type { ForkRepository } from "./worktreeForksConfig.ts";
import {
  applyArgv,
  driftInstallDirs,
  inspectCheckout,
  onlyLiveFileWarnings,
  sandboxEnvironment,
  shipState,
} from "./worktreeForkShip.ts";

const runner = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=T3",
      "-c",
      "user.email=t3@example.com",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

const write = (root: string, path: string, text: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), text);
};

const tempDir = (label: string) =>
  NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3wf-${label}-`)));

const repository = (ship: ReadonlyArray<string>, workDir: string): ForkRepository => ({
  repository: "acme/widgets",
  workDir,
  prepare: [],
  services: [],
  ship,
  key: "k",
});

/**
 * An upstream with two commits; `host` is a clone of it with origin on GitHub, `base` a second
 * clone checked out at the first commit, standing in for a copy's /work checkout.
 */
const setup = () => {
  const upstream = tempDir("upstream");
  git(upstream, "init", "-q");
  write(upstream, ".gitignore", ".env\nignored.txt\ngen/\nnode_modules/\n");
  write(upstream, "a.txt", "a1\n");
  write(upstream, "b.txt", "b1\n");
  write(upstream, "gone.txt", "soon gone\n");
  write(upstream, "bun.lock", "{}\n");
  write(upstream, "pkg/package.json", '{"name":"pkg"}\n');
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "first");
  const first = git(upstream, "rev-parse", "HEAD");
  write(upstream, "a.txt", "a2\n");
  git(upstream, "commit", "-qam", "second");
  const second = git(upstream, "rev-parse", "HEAD");
  const host = NodePath.join(tempDir("host"), "widgets");
  git(NodePath.dirname(host), "clone", "-q", upstream, host);
  git(host, "remote", "set-url", "origin", "git@github.com:Acme/widgets.git");
  const base = NodePath.join(tempDir("base"), "widgets");
  git(NodePath.dirname(base), "clone", "-q", upstream, base);
  git(base, "checkout", "-q", "--detach", first);
  return { host, base, first, second };
};

/** Every file a worktree shows: tracked and untracked but not ignored, plus `extra`. */
const visibleFiles = (root: string, extra: ReadonlyArray<string> = []) =>
  Object.fromEntries(
    [...git(root, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean), ...extra]
      .filter((path) => NodeFS.existsSync(NodePath.join(root, path)))
      .toSorted()
      .map((path) => [path, NodeFS.readFileSync(NodePath.join(root, path), "utf8")]),
  );

/** Runs the apply step as a copy would, with `bun` faked to record where it installed. */
const applyInCopy = (argv: ReadonlyArray<string>) => {
  const bin = tempDir("bin");
  const installs = NodePath.join(bin, "installs");
  NodeFS.writeFileSync(
    NodePath.join(bin, "bun"),
    `#!/bin/sh\necho "$(pwd) $*" >> '${installs}'\n`,
    { mode: 0o755 },
  );
  NodeChildProcess.execFileSync(argv[0]!, argv.slice(1), {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: "pipe",
  });
  return NodeFS.existsSync(installs) ? NodeFS.readFileSync(installs, "utf8") : "";
};

it.effect(
  "a copy at the base reproduces the worktree: new commits, staged, unstaged, untracked, deletions and ship paths",
  () =>
    Effect.gen(function* () {
      const { host, base, first } = setup();
      write(host, "pkg/package.json", '{"name":"pkg","version":"2"}\n');
      git(host, "checkout", "-qb", "feature");
      git(host, "commit", "-qam", "local commit");
      write(host, "staged.txt", "staged\n");
      git(host, "add", "staged.txt");
      write(host, "b.txt", "b unstaged\n");
      NodeFS.rmSync(NodePath.join(host, "gone.txt"));
      write(host, "dir/new.txt", "untracked\n");
      write(host, "ignored.txt", "stays home\n");
      write(host, ".env", "SECRET=1\n");
      write(host, "gen/out.ts", "export const x = 1;\n");

      const checkout = yield* inspectCheckout(
        NodePath.join(host, "dir"),
        new Map([["acme/widgets", repository([".env", "gen", "absent.env"], base)]]),
      );
      expect(checkout).toMatchObject({
        root: host,
        cwd: NodePath.join(host, "dir"),
        branch: "feature",
        head: git(host, "rev-parse", "HEAD"),
      });
      const shipment = yield* shipState(checkout, first, tempDir("ship"));
      expect(shipment.driftDirs).toEqual(["."]);
      const packed = yield* shipment.state.pack;
      expect(packed.key).toBe(shipment.state.key);
      // The same state keys the same, so its copies share one upload; any change keys anew.
      expect((yield* shipState(checkout, first, tempDir("ship"))).state.key).toBe(
        shipment.state.key,
      );
      write(host, "b.txt", "b changed again\n");
      expect((yield* shipState(checkout, first, tempDir("ship"))).state.key).not.toBe(
        shipment.state.key,
      );
      write(host, "b.txt", "b unstaged\n");

      const installs = applyInCopy(applyArgv(shipment, packed.archive));

      expect(git(base, "rev-parse", "HEAD")).toBe(checkout.head);
      expect(git(base, "symbolic-ref", "--short", "HEAD")).toBe("feature");
      expect(visibleFiles(base, [".env", "gen/out.ts"])).toEqual(
        visibleFiles(host, [".env", "gen/out.ts"]),
      );
      expect(NodeFS.existsSync(NodePath.join(base, "gone.txt"))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(base, "ignored.txt"))).toBe(false);
      expect(installs).toBe(`${base} install --frozen-lockfile\n`);
    }).pipe(Effect.provide(runner)),
);

it.effect("a HEAD the base already contains is checked out by commit, with no bundle", () =>
  Effect.gen(function* () {
    const { host, base, first, second } = setup();
    git(base, "checkout", "-q", "--detach", second);
    git(host, "checkout", "-q", "--detach", first);
    const checkout = yield* inspectCheckout(
      host,
      new Map([["acme/widgets", repository([], base)]]),
    );
    expect(checkout.branch).toBeNull();
    const shipment = yield* shipState(checkout, second, tempDir("ship"));
    const { archive } = yield* shipment.state.pack;
    const listed = NodeChildProcess.execFileSync("tar", ["-tf", archive], {
      encoding: "utf8",
    });
    expect(listed).not.toContain("head.bundle");
    expect(shipment.driftDirs).toEqual([]);
    applyInCopy(applyArgv(shipment, archive));
    expect(git(base, "rev-parse", "HEAD")).toBe(first);
    expect(visibleFiles(base)).toEqual(visibleFiles(host));
  }).pipe(Effect.provide(runner)),
);

it.effect("refuses a directory outside git, an unlisted origin, and a base it lacks", () =>
  Effect.gen(function* () {
    const { host, base } = setup();
    const listed = new Map([["acme/widgets", repository([], base)]]);
    const reason = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
      effect.pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
    expect(yield* reason(inspectCheckout(tempDir("plain"), listed))).toBe("not_a_repository");
    expect(yield* reason(inspectCheckout(host, new Map()))).toBe("unconfigured_repository");
    const checkout = yield* inspectCheckout(host, listed);
    expect(yield* reason(shipState(checkout, "1".repeat(40), tempDir("ship")))).toBe(
      "missing_base_commit",
    );
  }).pipe(Effect.provide(runner)),
);

it("still ships a worktree whose files change or vanish while tar packs them, and nothing else", () => {
  // GNU tar's own messages: a live sqlite file an agent's test keeps writing, a temp file gone.
  expect(
    onlyLiveFileWarnings(
      "tar: .tmp-check/mail-lifecycle-d8nS3s/mind.sqlite: file changed as we read it\n",
    ),
  ).toBe(true);
  expect(
    onlyLiveFileWarnings(
      "tar: out/tmp-1: Cannot stat: No such file or directory\ntar: Exiting with failure status due to previous errors\n",
    ),
  ).toBe(true);
  expect(
    onlyLiveFileWarnings(
      "tar: src/a.ts: file changed as we read it\ntar: secret.pem: Cannot open: Permission denied\n",
    ),
  ).toBe(false);
  expect(onlyLiveFileWarnings("tar: Error is not recoverable: exiting now\n")).toBe(false);
  expect(onlyLiveFileWarnings("")).toBe(false);
});

it("installs again only where a manifest or lockfile changed, at its nearest lockfile", () => {
  const locks = new Set([".", "apps/api"]);
  expect(
    driftInstallDirs(
      [
        "apps/api/package.json",
        "apps/api/src/index.ts",
        "packages/ui/package.json",
        "bun.lock",
        "apps/api/nested/package.json",
        "README.md",
      ],
      (dir) => locks.has(dir),
    ),
  ).toEqual([".", "apps/api"]);
  expect(driftInstallDirs(["src/a.ts"], () => true)).toEqual([]);
  expect(driftInstallDirs(["pkg/package.json"], () => false)).toEqual([]);
});

it("gives the copy the caller's environment without the host's session, home or T3 state", () => {
  const root = "/home/andrew/.t3/worktrees/widgets/feat";
  const environment = sandboxEnvironment(
    {
      HOME: "/home/andrew",
      USER: "andrew",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/andrew",
      XDG_RUNTIME_DIR: "/run/user/1000",
      T3CODE_HOME: "/home/andrew/.t3",
      PATH: `${root}/node_modules/.bin:/home/andrew/.bun/bin:/usr/bin`,
      BUN_INSTALL: "/home/andrew/.bun",
      NODE_PATH: `/home/andrew/lib:${root}/lib`,
      CONFIG: `${root}/config.json`,
      NODE_OPTIONS: "--max-old-space-size=8192",
      DATABASE_URL: "postgres://db:5432/app",
    },
    root,
    "/home/andrew",
  );
  expect(environment).toEqual({
    PATH: `${root}/node_modules/.bin:/home/user/.bun/bin:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_PATH: `${root}/lib`,
    CONFIG: `${root}/config.json`,
    NODE_OPTIONS: "--max-old-space-size=8192",
    DATABASE_URL: "postgres://db:5432/app",
    HOME: "/home/user",
    USER: "root",
    LOGNAME: "root",
    IS_SANDBOX: "1",
  });
});
