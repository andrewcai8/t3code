// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space or machine-size query.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

/** Only a box's preparation names its host for usage. */
const onCloudBox = Effect.map(HostProcessEnvironment, (environment) =>
  Boolean(environment.T3CODE_USAGE_HOST_ID?.trim()),
);

/**
 * Below this much free space an agent is told to clean up after itself. A cloud box warns early
 * enough that one turn installing dependencies into several worktrees still has room to stop; a
 * user's own machine only when it is nearly full.
 */
const lowDiskBytes = (box: boolean) => (box ? 10 : 2) * 1024 ** 3;

/** What an agent is told when its working directory's disk is running low; empty otherwise. */
export function lowDiskNote(freeBytes: number, box: boolean): string {
  if (freeBytes >= lowDiskBytes(box)) return "";
  const free =
    freeBytes >= 1024 ** 3
      ? `${(freeBytes / 1024 ** 3).toFixed(1)} GB`
      : `${Math.max(0, Math.floor(freeBytes / 1024 ** 2))} MB`;
  return `Note: this machine's disk is running low, with ${free} free. Remove worktrees, dependency installs and build outputs you created and no longer need before installing or writing more; a full disk stops this chat from saving its work.`;
}

/** The note for `cwd`'s disk, or empty when it has room or cannot be read. */
export const lowDiskNoteFor = (cwd: string | null | undefined): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (!cwd) return "";
    const box = yield* onCloudBox;
    return yield* Effect.tryPromise(() => NodeFSP.statfs(cwd)).pipe(
      Effect.map((stats) => lowDiskNote(stats.bavail * stats.bsize, box)),
      Effect.orElseSucceed(() => ""),
    );
  });

export interface CloudMachine {
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly diskBytes: number;
  /** Whether t3_fork_run can copy this machine. */
  readonly forks: boolean;
}

const roundedGb = (bytes: number) => `${Math.round(bytes / 1024 ** 3)} GB`;

/** What a top-level chat on a cloud box is told about where heavy work belongs. */
export function cloudMachineNote(machine: CloudMachine): string {
  return [
    `Note: you are on a cloud machine used only by this chat (${machine.cpus} CPUs, ${roundedGb(machine.memoryBytes)} RAM, ${roundedGb(machine.diskBytes)} disk).`,
    machine.forks
      ? "For parallel or heavy jobs (eval replays, test shards, separate builds) use t3_fork_run: each job runs in a throwaway copy of this machine and its outputs go to S3 under outputsUri. Don't create extra worktrees and installs here."
      : "",
    "Keep large results in S3, not on this disk.",
    "Remove worktrees, installs and /tmp data you created once you no longer need them.",
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
}

/** The native threads each live provider session has told, forgotten with the session. */
const toldBySession = new WeakMap<object, Set<string>>();

/**
 * The cloud machine note, sent on the first turn of each provider session for a native thread: a
 * new chat, and also a chat resumed after a wake, a restart or an account switch, since a chat
 * that began before the note existed, or lost it to compaction, would otherwise never hear it.
 * `session` is the live provider session runtime. Only a box's top-level chats reach t3_fork_run
 * through their host, and only when their provider exposes MCP tools. Forks copy only E2B
 * machines, so a Mac box's chats are not pointed at them.
 */
export const cloudMachineNoteFor = (input: {
  readonly cwd: string | null | undefined;
  readonly subagent: boolean;
  readonly mcpTools: boolean;
  readonly session: object;
  readonly nativeThreadId: string;
}): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (!input.cwd || input.subagent || !(yield* onCloudBox)) return "";
    const told = toldBySession.get(input.session) ?? new Set<string>();
    if (told.has(input.nativeThreadId)) return "";
    toldBySession.set(input.session, told.add(input.nativeThreadId));
    const forks = input.mcpTools && (yield* HostProcessPlatform) !== "darwin";
    const cwd = input.cwd;
    return yield* Effect.tryPromise(() => NodeFSP.statfs(cwd)).pipe(
      Effect.map((stats) =>
        cloudMachineNote({
          cpus: NodeOS.availableParallelism(),
          memoryBytes: NodeOS.totalmem(),
          diskBytes: stats.blocks * stats.bsize,
          forks,
        }),
      ),
      Effect.orElseSucceed(() => ""),
    );
  });
