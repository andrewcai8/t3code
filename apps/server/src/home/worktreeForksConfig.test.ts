// @effect-diagnostics nodeBuiltinImport:off - the configuration is a real file in a temp state dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { copySpec } from "./modalForkSandboxes.ts";
import { baseKey, type ModalPlatform, readWorktreeForksConfig } from "./worktreeForksConfig.ts";

const stateDirWith = (config: unknown) => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3wf-config-"));
  if (config !== undefined)
    NodeFS.writeFileSync(NodePath.join(stateDir, "worktree-forks.json"), JSON.stringify(config), {
      mode: 0o600,
    });
  return stateDir;
};

const modal = { tokenId: "ak-1", tokenSecret: "as-1", imageId: "im-template" };
const e2b = { apiKey: "e2b_key", templateId: "tpl-template" };
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
        sizes: {
          huge: { cpu: 64, memoryGiB: 128, cpuRequest: 64, memoryRequestGiB: 100 },
          large: { cpu: 12, memoryGiB: 24 },
        },
        repositories: [megpt],
      }),
    );
    expect(host).toMatchObject({
      platforms: [{ kind: "modal", ...modal, app: "t3-worktree-forks" }],
      defaultSize: "default",
      maxConcurrent: 8,
      maxJobMs: 120 * 60_000,
      maxCopyBackBytes: 100 * 1024 * 1024,
      bunShim: { skipWhenSet: [], minTestFiles: 20 },
    });
    const gib = 1024;
    expect(Object.fromEntries(host!.sizes)).toEqual({
      default: { cpu: 8, memoryMiB: 16 * gib, cpuRequest: 2, memoryRequestMiB: 8 * gib },
      large: { cpu: 12, memoryMiB: 24 * gib, cpuRequest: 3, memoryRequestMiB: 12 * gib },
      xlarge: { cpu: 32, memoryMiB: 64 * gib, cpuRequest: 8, memoryRequestMiB: 32 * gib },
      huge: { cpu: 64, memoryMiB: 128 * gib, cpuRequest: 64, memoryRequestMiB: 100 * gib },
    });
    expect(host!.repositories.get("andrewcai8/megpt-mono")).toMatchObject({
      workDir: "/work/megpt-mono",
      prepare: ["node scripts/prepare.mjs"],
      services: ["bash backend.sh start"],
      ship: ["aura-hono-api/.env"],
    });
  }),
);

const megptKey = (host: Effect.Success<ReturnType<typeof readWorktreeForksConfig>>) =>
  baseKey(host!.platforms[0], host!.repositories.get("andrewcai8/megpt-mono")!);

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
        ).pipe(Effect.map(megptKey));
      const key = yield* keyOf({});
      const e2bKey = (templateId: string) =>
        readWorktreeForksConfig(
          stateDirWith({ e2b: { ...e2b, templateId }, repositories: [megpt] }),
        ).pipe(Effect.map(megptKey));
      // What an E2B record written before platforms had their own holds, so it is still used.
      expect(yield* e2bKey("tpl-template")).toBe(
        "e8ec7117731ffe8acd069ff65cfc7f2237101f343bb304fce36b07a30e4f4503",
      );
      expect(yield* e2bKey("im-template")).not.toBe(key);
      expect(yield* e2bKey("tpl-other")).not.toBe(yield* e2bKey("im-template"));
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

it.effect("the platforms are those configured, the one `platform` picks first", () =>
  Effect.gen(function* () {
    const platformsOf = (config: object) =>
      readWorktreeForksConfig(stateDirWith({ repositories: [], ...config })).pipe(
        Effect.map((host) => host!.platforms),
      );
    const kinds = (config: object) =>
      platformsOf(config).pipe(Effect.map((platforms) => platforms.map(({ kind }) => kind)));
    expect(yield* platformsOf({ modal })).toMatchObject([
      { kind: "modal", imageId: "im-template" },
    ]);
    expect(yield* platformsOf({ e2b })).toEqual([{ kind: "e2b", ...e2b }]);
    expect(yield* kinds({ modal, e2b, platform: "e2b" })).toEqual(["e2b", "modal"]);
    expect(yield* kinds({ modal, e2b, platform: "modal" })).toEqual(["modal", "e2b"]);
    expect(yield* kinds({ e2b, platform: "e2b" })).toEqual(["e2b"]);
    for (const config of [
      {},
      { modal, e2b },
      { e2b, platform: "modal" },
      { modal, platform: "e2b" },
    ])
      expect(
        (yield* readWorktreeForksConfig(stateDirWith({ repositories: [], ...config })).pipe(
          Effect.flip,
        )).operation,
      ).toBe("decode");
  }),
);

it.effect(
  "refuses a file that names a missing default size, requests more than a size's limit, repeats a repository, or is not JSON",
  () =>
    Effect.gen(function* () {
      for (const stateDir of [
        stateDirWith({ modal, defaultSize: "tiny", repositories: [] }),
        stateDirWith({
          modal,
          sizes: { big: { cpu: 4, memoryGiB: 8, cpuRequest: 8 } },
          repositories: [],
        }),
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

it.effect("bunShim false turns the shim off, and minTestFiles sets its size floor", () =>
  Effect.gen(function* () {
    const off = yield* readWorktreeForksConfig(
      stateDirWith({ modal, repositories: [], bunShim: false }),
    );
    expect(off!.bunShim).toBeNull();
    const raised = yield* readWorktreeForksConfig(
      stateDirWith({ modal, repositories: [], bunShim: { minTestFiles: 50 } }),
    );
    expect(raised!.bunShim).toEqual({ skipWhenSet: [], minTestFiles: 50 });
    const zero = stateDirWith({ modal, repositories: [], bunShim: { minTestFiles: 0 } });
    expect((yield* readWorktreeForksConfig(zero).pipe(Effect.flip)).operation).toBe("decode");
  }),
);

it.effect("a copy reserves its size's requests and may burst to its limits", () =>
  Effect.gen(function* () {
    const host = yield* readWorktreeForksConfig(stateDirWith({ modal, repositories: [megpt] }));
    const spec = copySpec(host!.platforms[0] as ModalPlatform, {
      imageId: "im-base",
      size: host!.sizes.get("default")!,
      lifetimeMs: 60_000,
      tags: {},
    });
    expect(spec.sizing).toEqual({
      cpu: 2,
      cpuLimit: 8,
      memoryMiB: 8 * 1024,
      memoryLimitMiB: 16 * 1024,
    });
  }),
);
