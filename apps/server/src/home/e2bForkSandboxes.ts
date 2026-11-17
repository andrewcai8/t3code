// @effect-diagnostics globalDate:off - a snapshot's age is a wall-clock time at the SDK boundary.
// @effect-diagnostics nodeBuiltinImport:off - downloads stream into a file on this host.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import type * as NodeStreamWeb from "node:stream/web";

import { CommandExitError, E2B, SandboxNotFoundError, type Sandbox } from "e2b";

import { uploadFile } from "../environmentControl/E2bProvisionRuntime.ts";
import { captureDisk } from "../environmentControl/ForkMachines.ts";
import { shellQuote } from "./forkExecProtocol.ts";
import type { E2bPlatform, ForkSandboxes } from "./worktreeForksConfig.ts";

/** What a sandbox's login shell would otherwise reset: the template's tools, for root. */
const GUEST_PATH =
  "/home/user/.bun/bin:/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/** A request outlives its command's own timeout, which is what bounds a job. */
const REQUEST_SLACK_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 600_000;
const STEP_TIMEOUT_MS = 120_000;
/** A snapshot this process took is not pruned while its build may still be recording it. */
const FRESH_MS = 15 * 60_000;
/** Distinct from ForkMachines' capture prefix, whose sweep deletes what it matches. */
const SNAPSHOT_PREFIX = "t3-fork-base-";

/** A copy booted from a disk snapshot comes up with swap off; the template's swapfile is still there. */
const SWAP_SCRIPT = `grep -q '^/swapfile ' /proc/swaps || /sbin/swapon /swapfile`;

/** `team/name:tag` and `name:tag` and a bare id compare as the same snapshot. */
const bare = (id: string) =>
  id
    .replace(/:[^/]*$/, "")
    .split("/")
    .at(-1) ?? id;

export const commandOf = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) =>
  `exec env ${Object.entries({ PATH: GUEST_PATH, ...env })
    .map(([name, value]) => shellQuote(`${name}=${value}`))
    .join(" ")} ${argv.map(shellQuote).join(" ")}`;

/**
 * Copies on E2B. Every exec runs as root, as on Modal, with the environment set by `env` itself
 * because a login shell resets PATH. A copy's size is its template's.
 */
export const makeE2bForkSandboxes = (platform: E2bPlatform, hostTag: string): ForkSandboxes => {
  const e2b = new E2B({ apiKey: platform.apiKey });
  const prefix = `${SNAPSHOT_PREFIX}${hostTag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 20)}-`;
  const known = new Map<string, Sandbox>();
  const fresh = new Map<string, number>();

  const box = async (sandboxId: string) => {
    const connected =
      known.get(sandboxId) ?? (await e2b.Sandbox.connect(sandboxId, { timeoutMs: 1_000 }));
    known.set(sandboxId, connected);
    return connected;
  };

  const run = async (
    sandbox: Sandbox,
    argv: ReadonlyArray<string>,
    options: {
      readonly timeoutMs: number;
      readonly env?: Readonly<Record<string, string>>;
      readonly workdir?: string;
      readonly stdin?: string;
      readonly onStdout?: (text: string) => void;
      readonly onStderr?: (text: string) => void;
    },
  ) => {
    const handle = await sandbox.commands.run(commandOf(argv, options.env), {
      background: true,
      user: "root",
      stdin: options.stdin !== undefined,
      timeoutMs: options.timeoutMs,
      requestTimeoutMs: options.timeoutMs + REQUEST_SLACK_MS,
      ...(options.workdir === undefined ? {} : { cwd: options.workdir }),
      ...(options.onStdout === undefined ? {} : { onStdout: options.onStdout }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
    });
    if (options.stdin !== undefined) {
      await handle.sendStdin(options.stdin);
      await handle.closeStdin();
    }
    try {
      const { exitCode, stdout, stderr } = await handle.wait();
      return { exitCode, stdout, stderr };
    } catch (error) {
      if (error instanceof CommandExitError)
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      throw error;
    }
  };

  /** Best effort: a copy without swap is only less able to take a memory spike. */
  const ensureSwap = (sandbox: Sandbox) =>
    run(sandbox, ["sh", "-c", SWAP_SCRIPT], { timeoutMs: STEP_TIMEOUT_MS }).catch(() => undefined);

  // Disk only: each E2B host must fetch a whole memory image before its first copy boots, which
  // put setup at 1-4 minutes under the mini PC's load. A cold page cache costs a heavy job far less.
  const takeSnapshot = async (sandboxId: string, name: string, timeoutMs: number) =>
    (await captureDisk(platform.apiKey, sandboxId, name, AbortSignal.timeout(timeoutMs))) ??
    (await e2b.Sandbox.createSnapshot(sandboxId, { name, requestTimeoutMs: timeoutMs })).snapshotId;

  return {
    createCopy: async ({ imageId, lifetimeMs, tags }) => {
      const sandbox = await e2b.Sandbox.create(imageId, {
        timeoutMs: lifetimeMs,
        metadata: { ...tags },
        requestTimeoutMs: TRANSFER_TIMEOUT_MS,
      });
      known.set(sandbox.sandboxId, sandbox);
      await ensureSwap(sandbox);
      return sandbox.sandboxId;
    },
    exec: async (sandboxId, argv, { timeoutMs, env, workdir, stdin }) =>
      run(await box(sandboxId), argv, {
        timeoutMs,
        ...(env === undefined ? {} : { env }),
        ...(workdir === undefined ? {} : { workdir }),
        ...(stdin === undefined ? {} : { stdin }),
      }),
    execStream: async (sandboxId, argv, { timeoutMs, env, workdir, onOutput }) =>
      (
        await run(await box(sandboxId), argv, {
          timeoutMs,
          ...(env === undefined ? {} : { env }),
          ...(workdir === undefined ? {} : { workdir }),
          onStdout: (text) => onOutput("stdout", text),
          onStderr: (text) => onOutput("stderr", text),
        })
      ).exitCode,
    upload: async (sandboxId, localPath, remotePath) => {
      const sandbox = await box(sandboxId);
      const { size } = await NodeFS.promises.stat(localPath);
      await uploadFile(await sandbox.uploadUrl(remotePath, { user: "root" }), localPath, size);
    },
    download: async (sandboxId, remotePath, localPath) => {
      const stream = await (
        await box(sandboxId)
      ).files.read(remotePath, {
        format: "stream",
        user: "root",
        requestTimeoutMs: TRANSFER_TIMEOUT_MS,
        streamIdleTimeoutMs: STEP_TIMEOUT_MS,
      });
      await NodeStreamPromises.pipeline(
        NodeStream.Readable.fromWeb(stream as NodeStreamWeb.ReadableStream<Uint8Array>),
        NodeFS.createWriteStream(localPath),
      );
    },
    saveDisk: async (sandboxId, _ttlMs, timeoutMs = 300_000) => {
      const name = `${prefix}${NodeCrypto.randomUUID().slice(0, 12)}`;
      // Marked before the call too: the sweep may list a snapshot E2B is still taking.
      fresh.set(name, Date.now());
      const snapshotId = await takeSnapshot(sandboxId, name, timeoutMs);
      fresh.set(bare(snapshotId), Date.now());
      return snapshotId;
    },
    // False is E2B's answer for a snapshot already gone. One a sandbox still runs from is refused,
    // and pruneImages deletes it once that sandbox has ended.
    deleteImage: async (imageId) => void (await e2b.Sandbox.deleteSnapshot(imageId)),
    pruneImages: async (keep) => {
      const kept = new Set([...keep].map(bare));
      const now = Date.now();
      for (const [id, at] of fresh) if (now - at >= FRESH_MS) fresh.delete(id);
      const stale: Array<string> = [];
      const listed = e2b.Sandbox.listSnapshots({ limit: 100 });
      while (listed.hasNext)
        for (const snapshot of await listed.nextItems()) {
          const ids = [snapshot.snapshotId, ...snapshot.names].map(bare);
          if (!snapshot.names.some((name) => bare(name).startsWith(prefix))) continue;
          if (ids.some((id) => kept.has(id) || fresh.has(id))) continue;
          stale.push(snapshot.snapshotId);
        }
      await Promise.allSettled(stale.map((id) => e2b.Sandbox.deleteSnapshot(id)));
    },
    terminate: async (sandboxId) => {
      known.delete(sandboxId);
      try {
        await e2b.Sandbox.kill(sandboxId);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    },
    list: async (tags) => {
      const found: Array<{ sandboxId: string; tags: Record<string, string> }> = [];
      const listed = e2b.Sandbox.list({
        query: { metadata: { ...tags }, state: ["running"] },
        limit: 100,
      });
      while (listed.hasNext)
        for (const sandbox of await listed.nextItems())
          found.push({ sandboxId: sandbox.sandboxId, tags: { ...sandbox.metadata } });
      return found;
    },
    directoryImages: null,
  };
};
