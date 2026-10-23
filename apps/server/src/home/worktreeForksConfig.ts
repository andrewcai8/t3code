// @effect-diagnostics nodeBuiltinImport:off - a small private file read once at startup.
/**
 * `<stateDir>/worktree-forks.json`: a self-hosted server's own Modal backend for fork-exec and
 * t3_fork_run (see WorktreeForks.ts). The file holds a Modal token, so it lives beside
 * settings.json rather than in settings, which are sent to clients, and like
 * environment-control.json it is the operator's to keep private.
 *
 * @module worktreeForksConfig
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  canonicalRepository,
  isBackground,
  PrepareCommand,
  RelativeFilePath,
} from "../environmentControl/config.ts";
import type { ModalBoxes, ModalCopySpec } from "../environmentControl/ModalRuntime.ts";
import type { BunShimSettings } from "./bunShim.ts";

const Bounded = (maximum: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }));

/**
 * `cpu` and `memoryGiB` cap a copy; the requests are what Modal reserves and bills at least.
 * A copy bursts past them while its host has room, and Modal bills max(request, use).
 */
const ForkSize = Schema.Struct({
  cpu: Bounded(64),
  memoryGiB: Bounded(512),
  cpuRequest: Schema.optional(Bounded(64)),
  memoryRequestGiB: Schema.optional(Bounded(512)),
});

const WorktreeForksFile = Schema.Struct({
  modal: Schema.Struct({
    tokenId: TrimmedNonEmptyString,
    tokenSecret: TrimmedNonEmptyString,
    /** The image a repository's first base is built from: git, bash, tar, gzip and its toolchain. */
    imageId: TrimmedNonEmptyString,
    app: Schema.optional(TrimmedNonEmptyString),
    environment: Schema.optional(TrimmedNonEmptyString),
  }),
  defaultSize: Schema.optional(TrimmedNonEmptyString),
  /** Merged over the built-in sizes. */
  sizes: Schema.optional(Schema.Record(TrimmedNonEmptyString, ForkSize)),
  maxConcurrent: Schema.optional(Bounded(256)),
  maxJobMinutes: Schema.optional(Bounded(1440)),
  maxCopyBackMiB: Schema.optional(Bounded(4096)),
  repositories: Schema.Array(
    Schema.Struct({
      repository: TrimmedNonEmptyString,
      /** Foreground ones prepare a base; background ones start services in every copy. */
      prepareCommands: Schema.optional(Schema.Array(PrepareCommand)),
      /** Ignored paths every build and copy takes from the worktree, never kept in an image. */
      ship: Schema.optional(Schema.Array(RelativeFilePath)),
    }),
  ),
  bunShim: Schema.optional(
    Schema.Union([
      Schema.Literal(false),
      Schema.Struct({
        skipWhenSet: Schema.optional(
          Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/))),
        ),
        minTestFiles: Schema.optional(Bounded(100_000)),
      }),
    ]),
  ),
});

const BUILT_IN_SIZES = {
  default: { cpu: 8, memoryGiB: 16 },
  large: { cpu: 16, memoryGiB: 32 },
  xlarge: { cpu: 32, memoryGiB: 64 },
} as const;

export interface SandboxSize {
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly cpuRequest: number;
  readonly memoryRequestMiB: number;
}

/**
 * Measured on Modal's vm runtime (2026-10-20): a megpt test shard peaked near 3 GiB and, with a
 * one-core request, still burst to all 8 cores. A quarter of the CPU keeps a floor if bursting
 * dries up; half the memory leaves headroom against eviction above the request.
 */
const sandboxSize = (size: typeof ForkSize.Type): SandboxSize => {
  const cpuRequest = size.cpuRequest ?? Math.max(1, Math.floor(size.cpu / 4));
  const memoryRequestGiB = size.memoryRequestGiB ?? Math.max(1, Math.floor(size.memoryGiB / 2));
  if (cpuRequest > size.cpu || memoryRequestGiB > size.memoryGiB)
    throw new Error("A size's request exceeds its limit");
  return {
    cpu: size.cpu,
    memoryMiB: size.memoryGiB * 1024,
    cpuRequest,
    memoryRequestMiB: memoryRequestGiB * 1024,
  };
};

export interface ForkRepository {
  /** Canonical owner/name, matched against a checkout's origin. */
  readonly repository: string;
  /** Where every base keeps the checkout; a copy moves it to the worktree's own path. */
  readonly workDir: string;
  readonly prepare: ReadonlyArray<string>;
  readonly services: ReadonlyArray<string>;
  readonly ship: ReadonlyArray<string>;
  /** Changes whenever what a base holds would: the template image, prepare commands or ship paths. */
  readonly key: string;
}

/** worktree-forks.json with defaults applied: the only shape the rest of the backend reads. */
export interface WorktreeForksHost {
  readonly modal: {
    readonly tokenId: string;
    readonly tokenSecret: string;
    readonly imageId: string;
    readonly app: string;
    readonly environment: string | undefined;
  };
  /** Always holds `defaultSize`. */
  readonly sizes: ReadonlyMap<string, SandboxSize>;
  readonly defaultSize: string;
  readonly maxConcurrent: number;
  readonly maxJobMs: number;
  readonly maxCopyBackBytes: number;
  /** By canonical owner/name. */
  readonly repositories: ReadonlyMap<string, ForkRepository>;
  /** Null when the bun shim is turned off. */
  readonly bunShim: BunShimSettings | null;
}

/** What the backend asks of Modal. Tests fake exactly these members. */
export type ForkSandboxes = Pick<
  ModalBoxes,
  | "createCopy"
  | "exec"
  | "execStream"
  | "upload"
  | "download"
  | "saveDisk"
  | "deleteImage"
  | "saveDirectory"
  | "mountImage"
  | "terminate"
  | "list"
>;

/** Every sandbox of this backend carries it, with the host and job, for the sweep. */
export const COPY_PURPOSE = "t3-worktree-fork";

/**
 * A sandbox booted from `imageId`, on the vm runtime, which ran a megpt-mono test shard in half
 * the time gVisor took. Egress stays open, like the host it stands in for.
 */
export const copySpec = (
  host: WorktreeForksHost,
  input: {
    readonly imageId: string;
    readonly size: SandboxSize;
    readonly lifetimeMs: number;
    readonly tags: Readonly<Record<string, string>>;
  },
): ModalCopySpec => ({
  app: host.modal.app,
  ...(host.modal.environment === undefined ? {} : { environment: host.modal.environment }),
  imageId: input.imageId,
  runtime: "vm",
  timeoutMs: input.lifetimeMs,
  sizing: {
    cpu: input.size.cpuRequest,
    cpuLimit: input.size.cpu,
    memoryMiB: input.size.memoryRequestMiB,
    memoryLimitMiB: input.size.memoryMiB,
  },
  tags: input.tags,
  egress: { domains: [], cidrs: [] },
});

export class WorktreeForksConfigError extends Schema.TaggedError<WorktreeForksConfigError>()(
  "WorktreeForksConfigError",
  {
    path: Schema.String,
    operation: Schema.Literals(["read", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the worktree forks configuration.`;
  }
}

const decodeFile = Schema.decodeUnknownSync(Schema.fromJsonString(WorktreeForksFile));

const repositoryOf = (
  imageId: string,
  entry: (typeof WorktreeForksFile.Type)["repositories"][number],
): ForkRepository => {
  const repository = canonicalRepository(entry.repository);
  const commands = entry.prepareCommands ?? [];
  const prepare = commands.flatMap((command) =>
    isBackground(command) ? [] : [typeof command === "string" ? command : command.command],
  );
  const ship = entry.ship ?? [];
  return {
    repository,
    workDir: `/work/${repository.split("/")[1]}`,
    prepare,
    services: commands.flatMap((command) =>
      typeof command !== "string" && isBackground(command) ? [command.command] : [],
    ),
    ship,
    key: NodeCrypto.createHash("sha256")
      .update(JSON.stringify([imageId, prepare, ship]))
      .digest("hex"),
  };
};

/** Applies defaults and the rules a schema cannot state; throws on a file that breaks one. */
const hostOf = (file: typeof WorktreeForksFile.Type): WorktreeForksHost => {
  const sizes = new Map<string, SandboxSize>(
    Object.entries({ ...BUILT_IN_SIZES, ...file.sizes }).map(([name, size]) => [
      name,
      sandboxSize(size),
    ]),
  );
  const defaultSize = file.defaultSize ?? "default";
  if (!sizes.has(defaultSize)) throw new Error(`defaultSize names no size: ${defaultSize}`);
  const repositories = new Map(
    file.repositories.map((entry) => {
      const repository = repositoryOf(file.modal.imageId, entry);
      return [repository.repository, repository] as const;
    }),
  );
  if (repositories.size !== file.repositories.length) throw new Error("Duplicate repository");
  return {
    modal: {
      tokenId: file.modal.tokenId,
      tokenSecret: file.modal.tokenSecret,
      imageId: file.modal.imageId,
      app: file.modal.app ?? "t3-worktree-forks",
      environment: file.modal.environment,
    },
    sizes,
    defaultSize,
    maxConcurrent: file.maxConcurrent ?? 8,
    maxJobMs: (file.maxJobMinutes ?? 120) * 60_000,
    maxCopyBackBytes: (file.maxCopyBackMiB ?? 100) * 1024 * 1024,
    repositories,
    bunShim:
      file.bunShim === false
        ? null
        : {
            skipWhenSet: file.bunShim?.skipWhenSet ?? [],
            // A copy takes about ten seconds to start, which a run of a few files does not earn back.
            minTestFiles: file.bunShim?.minTestFiles ?? 20,
          },
  };
};

/** The host's configuration, or null when it has no worktree-forks.json. */
export const readWorktreeForksConfig = Effect.fn("WorktreeForks.readConfig")(function* (
  stateDir: string,
) {
  const path = NodePath.join(stateDir, "worktree-forks.json");
  const text = yield* Effect.try({
    try: () => (NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null),
    catch: (cause) => new WorktreeForksConfigError({ path, operation: "read", cause }),
  });
  if (text === null) return null;
  if ((NodeFS.statSync(path).mode & 0o077) !== 0)
    yield* Effect.logWarning(
      "worktree-forks.json holds a Modal token and others can read it; chmod 600 it",
      { path },
    );
  return yield* Effect.try({
    try: () => hostOf(decodeFile(text)),
    catch: (cause) => new WorktreeForksConfigError({ path, operation: "decode", cause }),
  });
});
