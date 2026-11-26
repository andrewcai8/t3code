// @effect-diagnostics nodeBuiltinImport:off - a small private file read once at startup.
/**
 * `<stateDir>/worktree-forks.json`: a self-hosted server's own Modal or E2B backend for fork-exec and
 * t3_fork_run. It holds a Modal token or an E2B key, so it lives beside settings.json rather than
 * in settings, which are sent to clients, and is the operator's to keep private.
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
  modal: Schema.optional(
    Schema.Struct({
      tokenId: TrimmedNonEmptyString,
      tokenSecret: TrimmedNonEmptyString,
      /** The image a repository's first base is built from: git, bash, tar, gzip and its toolchain. */
      imageId: TrimmedNonEmptyString,
      app: Schema.optional(TrimmedNonEmptyString),
      environment: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
  e2b: Schema.optional(
    Schema.Struct({
      apiKey: TrimmedNonEmptyString,
      /** What a repository's first base is built from, as `imageId` is on Modal. */
      templateId: TrimmedNonEmptyString,
    }),
  ),
  /** The default backend when both are configured; with one, that one. A job may name the other. */
  platform: Schema.optional(Schema.Literals(["modal", "e2b"])),
  defaultSize: Schema.optional(TrimmedNonEmptyString),
  /** Merged over the built-in sizes. */
  sizes: Schema.optional(Schema.Record(TrimmedNonEmptyString, ForkSize)),
  maxConcurrent: Schema.optional(Bounded(256)),
  /** The E2B account's running-sandbox limit, shared with every other host on the key. Default 100. */
  e2bConcurrency: Schema.optional(Bounded(10_000)),
  /** Of it, how many E2B copies always leave free for other sandboxes to start. Default 5. */
  e2bChatReserve: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  ),
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
}

export interface ModalPlatform {
  readonly kind: "modal";
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly imageId: string;
  readonly app: string;
  readonly environment: string | undefined;
}

export interface E2bPlatform {
  readonly kind: "e2b";
  readonly apiKey: string;
  readonly templateId: string;
}

export type ForkPlatform = ModalPlatform | E2bPlatform;

/** What a repository's first base boots from. */
export const platformImage = (platform: ForkPlatform) =>
  platform.kind === "modal" ? platform.imageId : platform.templateId;

export const platformLabel = (kind: ForkPlatform["kind"]) => (kind === "modal" ? "Modal" : "E2B");

/** Names the account the platform's images live in, so another account's are never mounted. */
export const platformScope = (platform: ForkPlatform) =>
  platform.kind === "modal"
    ? [platform.tokenId, platform.app, platform.environment ?? ""].join("\0")
    : ["e2b", platform.apiKey].join("\0");

/**
 * Changes whenever what a repository's base on `platform` holds would: the platform and its template
 * image, prepare commands or ship paths.
 */
export const baseKey = (platform: ForkPlatform, repository: ForkRepository) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        platform.kind === "modal"
          ? [platform.imageId, repository.prepare, repository.ship]
          : ["e2b", platform.templateId, repository.prepare, repository.ship],
      ),
    )
    .digest("hex");

/** worktree-forks.json with defaults applied: the only shape the rest of the backend reads. */
export interface WorktreeForksHost {
  /** Every configured platform, the default first. */
  readonly platforms: readonly [ForkPlatform, ...Array<ForkPlatform>];
  /** Always holds `defaultSize`. */
  readonly sizes: ReadonlyMap<string, SandboxSize>;
  readonly defaultSize: string;
  /** This host's own cap on copies. */
  readonly maxConcurrent: number;
  /** Running sandboxes E2B copies may take on the account, other hosts' and chats' included. */
  readonly e2bRoom: number;
  readonly maxJobMs: number;
  readonly maxCopyBackBytes: number;
  /** By canonical owner/name. */
  readonly repositories: ReadonlyMap<string, ForkRepository>;
  /** Null when the bun shim is turned off. */
  readonly bunShim: BunShimSettings | null;
}

export interface ForkExecOptions {
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly workdir?: string;
}

export interface ForkExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What the backend asks of a sandbox platform, which each platform's adapter implements and tests
 * fake. Sandboxes and images are the platform's ids.
 */
export interface ForkSandboxes {
  /** A throwaway sandbox booted from `imageId`. A platform with fixed sizes accepts any `size`. */
  readonly createCopy: (input: {
    readonly imageId: string;
    readonly size: SandboxSize;
    readonly lifetimeMs: number;
    readonly tags: Readonly<Record<string, string>>;
  }) => Promise<string>;
  /** Runs `argv` as root; a non-zero exit is a result, not a failure. */
  readonly exec: (
    sandboxId: string,
    argv: ReadonlyArray<string>,
    options: ForkExecOptions & { readonly stdin?: string },
  ) => Promise<ForkExecResult>;
  /** Runs `argv`, handing each chunk of its output to `onOutput` as it arrives; answers its exit code. */
  readonly execStream: (
    sandboxId: string,
    argv: ReadonlyArray<string>,
    options: ForkExecOptions & {
      readonly onOutput: (stream: "stdout" | "stderr", text: string) => void;
    },
  ) => Promise<number>;
  readonly upload: (sandboxId: string, localPath: string, remotePath: string) => Promise<void>;
  readonly download: (sandboxId: string, remotePath: string, localPath: string) => Promise<void>;
  /** An image of a running sandbox's disk, kept `ttlMs` where the platform expires images, else until deleted. */
  readonly saveDisk: (
    sandboxId: string,
    ttlMs: number | null,
    timeoutMs?: number,
  ) => Promise<string>;
  /** Deletes an image; one that is gone is deleted. */
  readonly deleteImage: (imageId: string) => Promise<void>;
  /**
   * Deletes this host's images other than `keep`, which a delete that failed or a restart left
   * behind. For a platform that expires its own images it does nothing.
   */
  readonly pruneImages: (keep: ReadonlySet<string>) => Promise<void>;
  readonly terminate: (sandboxId: string) => Promise<void>;
  /** This backend's running sandboxes that carry every one of `tags`. */
  readonly list: (
    tags: Readonly<Record<string, string>>,
  ) => Promise<
    ReadonlyArray<{ readonly sandboxId: string; readonly tags: Readonly<Record<string, string>> }>
  >;
  /**
   * The metadata of every running sandbox on the account, whoever made it, for a platform whose
   * copies share one running-sandbox limit with the rest of the account; null where they share none.
   */
  readonly accountRunning: (() => Promise<ReadonlyArray<Readonly<Record<string, string>>>>) | null;
  /** Images of one directory, shown in other sandboxes; null where the platform has none. */
  readonly directoryImages: {
    readonly save: (sandboxId: string, path: string, ttlMs: number) => Promise<string>;
    readonly mount: (sandboxId: string, path: string, imageId: string) => Promise<void>;
  } | null;
}

/** Every sandbox of this backend carries it, with the host and job, for the sweep. */
export const COPY_PURPOSE = "t3-worktree-fork";

/** `createCopy` made nothing because the platform has no room for one for now, so it may be retried. */
export class SandboxesBusy extends Schema.TaggedError<SandboxesBusy>()("SandboxesBusy", {
  cause: Schema.Defect(),
}) {}

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
  };
};

const platformsOf = (file: typeof WorktreeForksFile.Type): WorktreeForksHost["platforms"] => {
  const { modal, e2b } = file;
  const configured = [
    ...(modal === undefined
      ? []
      : [
          {
            kind: "modal" as const,
            tokenId: modal.tokenId,
            tokenSecret: modal.tokenSecret,
            imageId: modal.imageId,
            app: modal.app ?? "t3-worktree-forks",
            environment: modal.environment,
          },
        ]),
    ...(e2b === undefined
      ? []
      : [{ kind: "e2b" as const, apiKey: e2b.apiKey, templateId: e2b.templateId }]),
  ];
  const [only, other] = configured;
  if (only === undefined) throw new Error("Configure modal or e2b");
  if (other === undefined) {
    if (file.platform !== undefined && file.platform !== only.kind)
      throw new Error(`platform is ${file.platform} but ${file.platform} is not configured`);
    return [only];
  }
  if (file.platform === undefined)
    throw new Error("Both modal and e2b are configured; platform picks the default");
  return only.kind === file.platform ? [only, other] : [other, only];
};

/** Applies defaults and the rules a schema cannot state; throws on a file that breaks one. */
const hostOf = (file: typeof WorktreeForksFile.Type): WorktreeForksHost => {
  const platforms = platformsOf(file);
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
      const repository = repositoryOf(entry);
      return [repository.repository, repository] as const;
    }),
  );
  if (repositories.size !== file.repositories.length) throw new Error("Duplicate repository");
  return {
    platforms,
    sizes,
    defaultSize,
    maxConcurrent: file.maxConcurrent ?? 8,
    e2bRoom: (file.e2bConcurrency ?? 100) - (file.e2bChatReserve ?? 5),
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
      "worktree-forks.json holds a Modal token or E2B key and others can read it; chmod 600 it",
      { path },
    );
  return yield* Effect.try({
    try: () => hostOf(decodeFile(text)),
    catch: (cause) => new WorktreeForksConfigError({ path, operation: "decode", cause }),
  });
});
