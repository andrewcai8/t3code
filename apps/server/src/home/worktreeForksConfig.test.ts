// @effect-diagnostics nodeBuiltinImport:off - the configuration is a real file in a temp state dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readWorktreeForksConfig } from "./worktreeForksConfig.ts";

const stateDirWith = (config: unknown) => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-config-"));
  if (config !== undefined)
    NodeFS.writeFileSync(NodePath.join(stateDir, "worktree-forks.json"), JSON.stringify(config), {
      mode: 0o600,
    });
  return stateDir;
};

const modal = { tokenId: "ak-1", tokenSecret: "as-1", imageId: "im-template" };
const megpt = {
  repository: "https://github.com/AndrewCai8/megpt-mono.git",
  prepareCommands: [
    "node scripts/prepare.mjs",
    { command: "bash backend.sh start", background: true },
  ],
  ship: ["aura-hono-api/.env"],
};

it.effect("a host without the file has no backend", () =>
  Effect.gen(function* () {
    expect(yield* readWorktreeForksConfig(stateDirWith(undefined))).toBeNull();
  }),
);

it.effect("applies defaults and merges sizes over the built-in ones", () =>
  Effect.gen(function* () {
    const host = yield* readWorktreeForksConfig(
      stateDirWith({
        modal,
        sizes: { huge: { cpu: 64, memoryGiB: 128 }, large: { cpu: 12, memoryGiB: 24 } },
        repositories: [megpt],
      }),
    );
    expect(host).toMatchObject({
      modal: { ...modal, app: "t3-worktree-forks" },
      defaultSize: "default",
      maxConcurrent: 8,
      maxJobMs: 120 * 60_000,
      maxCopyBackBytes: 100 * 1024 * 1024,
      bunShim: { skipWhenSet: [] },
    });
    expect(Object.fromEntries(host!.sizes)).toEqual({
      default: { cpu: 8, memoryMiB: 16 * 1024 },
      large: { cpu: 12, memoryMiB: 24 * 1024 },
      xlarge: { cpu: 32, memoryMiB: 64 * 1024 },
      huge: { cpu: 64, memoryMiB: 128 * 1024 },
    });
    expect(host!.repositories.get("andrewcai8/megpt-mono")).toMatchObject({
      workDir: "/work/megpt-mono",
      prepare: ["node scripts/prepare.mjs"],
      services: ["bash backend.sh start"],
      ship: ["aura-hono-api/.env"],
    });
  }),
);

it.effect(
  "a base is rebuilt when its image, prepare commands or ship paths change, not its services",
  () =>
    Effect.gen(function* () {
      const keyOf = (overrides: { readonly imageId?: string; readonly repository?: object }) =>
        readWorktreeForksConfig(
          stateDirWith({
            modal: { ...modal, ...(overrides.imageId ? { imageId: overrides.imageId } : {}) },
            repositories: [{ ...megpt, ...overrides.repository }],
          }),
        ).pipe(Effect.map((host) => host!.repositories.get("andrewcai8/megpt-mono")!.key));
      const key = yield* keyOf({});
      expect(yield* keyOf({ imageId: "im-other" })).not.toBe(key);
      expect(yield* keyOf({ repository: { prepareCommands: ["make"] } })).not.toBe(key);
      expect(yield* keyOf({ repository: { ship: [] } })).not.toBe(key);
      expect(
        yield* keyOf({
          repository: {
            prepareCommands: [
              "node scripts/prepare.mjs",
              { command: "redis-server --daemonize yes", background: true },
            ],
          },
        }),
      ).toBe(key);
    }),
);

it.effect(
  "refuses a file that names a missing default size, repeats a repository, or is not JSON",
  () =>
    Effect.gen(function* () {
      for (const stateDir of [
        stateDirWith({ modal, defaultSize: "tiny", repositories: [] }),
        stateDirWith({ modal, repositories: [megpt, { repository: "andrewcai8/megpt-mono" }] }),
        stateDirWith({ modal, repositories: [{ repository: "not a repo" }] }),
      ]) {
        const error = yield* readWorktreeForksConfig(stateDir).pipe(Effect.flip);
        expect(error.operation).toBe("decode");
      }
      const broken = stateDirWith(undefined);
      NodeFS.writeFileSync(NodePath.join(broken, "worktree-forks.json"), "{");
      expect((yield* readWorktreeForksConfig(broken).pipe(Effect.flip)).operation).toBe("decode");
    }),
);

it.effect("bunShim false turns the shim off", () =>
  Effect.gen(function* () {
    const host = yield* readWorktreeForksConfig(
      stateDirWith({ modal, repositories: [], bunShim: false }),
    );
    expect(host!.bunShim).toBeNull();
  }),
);
