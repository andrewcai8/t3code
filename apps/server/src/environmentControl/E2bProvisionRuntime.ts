// @effect-diagnostics globalFetch:off globalDate:off globalTimers:off - Promise SDK adapters perform provider resolution and private remote HTTP, and bound their calls by wall-clock deadlines.
// @effect-diagnostics nodeBuiltinImport:off - SDK transfers read immutable local artifacts at the provider boundary.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeStreamPromises from "node:stream/promises";
import {
  CommandExitError,
  E2B,
  SandboxError,
  SandboxNotFoundError,
  type CommandResult,
  type E2BClientOpts,
  type Sandbox,
} from "e2b";
import type { ProvisionOperation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  brokerTokenScript,
  prepareRemoteHost,
  checkRemoteHost,
  sealWarmBase,
  type RemotePreparationPort,
} from "./remotePreparation.ts";
import { startProvisionPhase, type RecordProvisionPhase } from "./provisionTiming.ts";
import { withGuestProviderInstall } from "./guestProviderInstall.ts";
import type { ProvisionRuntimeArtifact } from "./config.ts";
import {
  desiredRuntime,
  fileDigest,
  followedBranch,
  type ProvisionPreparationManifest,
} from "./ProvisionPreparation.ts";

import { retentionTimeoutMs, verifyRetentionDeadline } from "./retention.ts";
import { credentialDestinations } from "./credentialDestinations.ts";
import { connectResumingE2b, type E2bResumeRetry } from "./e2bResume.ts";
import { GuestNotServing } from "./ProvisionControl.ts";
import { backUpBox } from "./boxBackup.ts";
import { readBoxHealth } from "./boxHealth.ts";

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/** Whole-host prepare: npm install + shallow clone + start T3. */
const PREPARE_COMMAND_TIMEOUT_MS = 1_200_000;

/** E2B's wait() throws on any non-zero exit, hiding python stderr unless we unwrap it. */
export async function e2bPythonResult(
  run: Promise<CommandResult>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await run;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (error instanceof CommandExitError)
      return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
    throw error;
  }
}
const pairingResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ serving: Schema.Literal(false) }),
      Schema.Struct({
        serving: Schema.Literal(true),
        credential: Schema.String,
        brokerToken: Schema.String,
      }),
    ]),
  ),
);
const templateResponse = Schema.decodeUnknownSync(Schema.Struct({ templateID: Schema.String }));
const revisionResponse = Schema.decodeUnknownSync(
  Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) }),
);

export function makeProvisionResolution(config: {
  readonly apiKey: string;
  readonly githubToken?: string;
  readonly apiUrl?: string;
}) {
  return {
    template: async (alias: string) => {
      const response = await fetch(
        `${config.apiUrl ?? "https://api.e2b.app"}/templates/${encodeURIComponent(alias)}?limit=1`,
        { headers: { "X-API-Key": config.apiKey } },
      );
      if (!response.ok) throw new Error("The configured E2B template could not be resolved.");
      return templateResponse(await response.json()).templateID;
    },
    revision: async (repository: string, branch?: string) => {
      const match = /^(?:https:\/\/(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(
        repository,
      );
      if (!match) throw new Error("Repository must identify a GitHub owner and repository.");
      const response = await fetch(
        `https://api.github.com/repos/${match[1]}/${match[2]}/commits/${encodeURIComponent(branch ?? "HEAD")}`,
        {
          headers: {
            accept: "application/vnd.github+json",
            ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}),
          },
        },
      );
      if (!response.ok) throw new Error("The requested source revision could not be resolved.");
      return revisionResponse(await response.json()).sha;
    },
  };
}

/**
 * Home paths a warm base's seal removes whatever its build installed: every
 * login any driver reads, the GitHub token files, and Claude's account
 * record. A prepare command can write these too, and a base must never hand
 * one account's login to the next chat.
 */
export function warmSealHomePaths(): string[] {
  return [
    ...new Set([
      ...Object.values(credentialDestinations).flat(),
      // What a configured `githubToken` becomes.
      ".git-credentials",
      ".gitconfig",
      ".config/gh/hosts.yml",
      ".claude.json",
    ]),
  ];
}

/** Needs passwordless sudo, which the E2B template's user has. */
const dropPageCacheScript = String.raw`
import os, subprocess
os.sync()
subprocess.run(['sudo', '-n', 'sh', '-c', 'echo 3 > /proc/sys/vm/drop_caches'], check=True, timeout=120)
`;

/**
 * Lets envd keep the memory envd.service reserves for it. cgroup v2 protects a group only up to
 * what its parent holds, and E2B leaves `system.slice` with none, so an agent that fills the box
 * starves envd and the box stops answering. This is E2B's own drop-in, still behind its
 * `build-envd-memory-protection` flag. It is written, and systemd reloaded, only when it differs,
 * so it runs on every wake. Needs passwordless sudo, which the E2B template's user has.
 */
export const protectEnvdCommand = (directory = "/etc/systemd/system/system.slice.d") => {
  const file = shellQuote(`${directory}/10-e2b-envd.conf`);
  return `want='[Slice]
MemoryMin=128M
MemoryLow=256M'
[ "$(cat ${file} 2>/dev/null)" = "$want" ] || { sudo -n mkdir -p ${shellQuote(directory)} && printf '%s\\n' "$want" | sudo -n tee ${file} > /dev/null && sudo -n systemctl daemon-reload; }`;
};

/** Why envd could not be protected, or null once it is. Never throws. */
const protectEnvd = (sandbox: Sandbox) =>
  e2bPythonResult(
    sandbox.commands.run(protectEnvdCommand(), { timeoutMs: 30_000, requestTimeoutMs: 30_000 }),
  )
    .then(({ exitCode, stderr }) => (exitCode === 0 ? null : stderr.trim() || `exit ${exitCode}`))
    .catch((error: unknown) => String(error));

/** Freed pages keep their contents, and a snapshot stores only a zeroed page as nothing. */
const zeroFreeMemoryScript = String.raw`
import mmap, re
with open('/proc/meminfo') as meminfo:
    free = int(re.search(r'^MemFree:\s+(\d+) kB', meminfo.read(), re.M).group(1)) * 1024
# Leaves room for what is still running, so zeroing never invokes the OOM killer.
size = free - 512 * 1024 * 1024
if size > 0:
    zeros = bytes(64 * 1024 * 1024)
    with mmap.mmap(-1, size) as region:
        for offset in range(0, size, len(zeros)):
            region[offset:offset + len(zeros)] = zeros[:size - offset]
`;

const STDIN_CHUNK = 4 * 1024 * 1024;

/**
 * Streams a file to a sandbox upload URL at the pace the socket drains.
 * `files.write` goes through Node's fetch in the bundled server, which reads a
 * streamed body far ahead of the network: one 150 MB upload held about that
 * much again in memory, and four at once exhausted a 2 GB host.
 */
export async function uploadFile(url: string, path: string, size: number) {
  const target = new URL(url);
  const request = (target.protocol === "http:" ? NodeHttp : NodeHttps).request(target, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": size },
    signal: AbortSignal.timeout(PREPARE_COMMAND_TIMEOUT_MS),
  });
  const sent = NodeStreamPromises.pipeline(NodeFS.createReadStream(path), request);
  // envd can answer (a 401, say) before it reads the body, and then the
  // reset that ends the send would hide the status that explains it.
  const response = await new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    sent.catch(reject);
  });
  let body = "";
  try {
    for await (const chunk of response) body += chunk;
  } catch {
    // A reset can cut the error body short; the status still names the failure.
  }
  if (!response.statusCode || response.statusCode >= 300) {
    request.destroy();
    throw new Error(`The runtime artifact upload failed (${response.statusCode}): ${body}`);
  }
  await sent;
}

/** What a sandbox's guest verifies its preparation journal against. */
function guestInput(
  operation: ProvisionOperation,
  sandboxId: string,
  manifest: ProvisionPreparationManifest,
  extra: { readonly runtime?: ProvisionPreparationManifest["preparation"]["artifact"] } = {},
) {
  const follow = followedBranch(manifest);
  return withGuestProviderInstall(
    {
      ...manifest.preparation,
      resourceIdentity: `e2b:${sandboxId}`,
      requestHash: operation.requestHash,
      preparationHash: operation.request.preparationHash,
      ...extra,
      ...(follow ? { follow } : {}),
    },
    operation.request.agentDriver,
  );
}

function e2bPythonPort(sandbox: Sandbox, deadline?: number): RemotePreparationPort {
  // A port bound to a deadline gives each command what is left of it, and each request no more.
  const limits = () => {
    if (deadline === undefined) return { timeoutMs: PREPARE_COMMAND_TIMEOUT_MS };
    const left = Math.max(1_000, deadline - Date.now());
    return { timeoutMs: left, requestTimeoutMs: left };
  };
  return {
    executePython: async ({ script, stdin }) => {
      if (stdin.length === 0)
        return e2bPythonResult(sandbox.commands.run(`python3 -c ${shellQuote(script)}`, limits()));
      const command = await sandbox.commands.run(`python3 -c ${shellQuote(script)}`, {
        background: true,
        stdin: true,
        ...limits(),
      });
      try {
        // Each chunk is a round trip: a 2.5 MB preparation spec took about 2.5 s
        // in 256 KiB chunks and under 1 s in one.
        for (let offset = 0; offset < stdin.length; offset += STDIN_CHUNK)
          await command.sendStdin(stdin.slice(offset, offset + STDIN_CHUNK));
        await command.closeStdin();
        return await e2bPythonResult(command.wait());
      } finally {
        await command.disconnect();
      }
    },
  };
}

export function makeE2bProvisionRuntime(
  connection: E2BClientOpts,
  onResumeRetry?: (retry: E2bResumeRetry) => void,
) {
  const client = new E2B(connection);
  const verify = async (
    operation: ProvisionOperation,
    sandboxId: string,
    requestTimeoutMs?: number,
  ) => {
    const info = await client.Sandbox.getInfo(
      sandboxId,
      requestTimeoutMs === undefined ? undefined : { requestTimeoutMs },
    );
    if (
      operation.request.provider !== "e2b" ||
      info.templateId !== operation.request.templateId ||
      info.metadata.provision_request_id !== operation.request.requestId ||
      info.metadata.provision_request_hash !== operation.requestHash ||
      info.metadata.preparation_hash !== operation.request.preparationHash ||
      info.metadata.account !== operation.request.providerInstanceId
    )
      throw new Error("The remote resource does not belong to this provisioning operation.");
    return info;
  };
  const connect = async (operation: ProvisionOperation, sandboxId: string) => {
    await verify(operation, sandboxId);
    const sandbox = await connectResumingE2b(
      sandboxId,
      (requestTimeoutMs) =>
        client.Sandbox.connect(sandboxId, {
          requestTimeoutMs,
          timeoutMs: retentionTimeoutMs(operation.request.retentionDeadline, 6 * 3_600_000),
        }),
      onResumeRetry,
    );
    await verifyRetentionDeadline(operation.request.retentionDeadline, {
      read: async () => (await verify(operation, sandboxId)).endAt,
      shorten: (timeoutMs) => sandbox.setTimeout(timeoutMs),
    });
    return sandbox;
  };
  /**
   * Connects to a box only while E2B reports it running, keeping the timeout it has, and with no
   * retry; null for a box that is paused, about to time out, or past `deadline`. Unlike `connect`
   * it can never wake a box a host paused meanwhile.
   */
  const connectAwake = async (
    operation: ProvisionOperation,
    sandboxId: string,
    deadline: number,
  ) => {
    const requestTimeoutMs = () => Math.min(10_000, deadline - Date.now());
    if (requestTimeoutMs() < 1_000) return null;
    const info = await verify(operation, sandboxId, requestTimeoutMs());
    const left = info.endAt.getTime() - Date.now();
    if (info.state !== "running" || left < 60_000 || requestTimeoutMs() < 1_000) return null;
    return client.Sandbox.connect(sandboxId, {
      requestTimeoutMs: requestTimeoutMs(),
      timeoutMs: left,
    });
  };
  const prepare = async (
    operation: ProvisionOperation,
    sandboxId: string,
    manifest: ProvisionPreparationManifest,
    record?: RecordProvisionPhase,
    runtime: ProvisionRuntimeArtifact | null = null,
  ) => {
    const sandbox = await connect(operation, sandboxId);
    const stopProtect = startProvisionPhase(record);
    // Best effort: a box without it still works, and the next wake tries again.
    stopProtect((await protectEnvd(sandbox)) === null ? "envd.protect" : "envd.protectFailed");
    const { local: desired, guest } = desiredRuntime(manifest, runtime);
    const stopDigest = startProvisionPhase(record);
    const { size } = await NodeFS.promises.stat(desired.path);
    if ((await fileDigest(desired.path)) !== desired.sha256)
      throw new Error("The stored runtime artifact changed.");
    stopDigest("artifact.digest", { bytes: size });
    const transport = e2bPythonPort(sandbox);
    const stopPresence = startProvisionPhase(record);
    // The guest reads the archive only to extract a runtime it does not have
    // yet. A box that already holds this build (a warm base, a resume) is
    // asked nothing more, and the check stays a shell builtin because a
    // restored box takes seconds to page in its first interpreter.
    const installed = `${manifest.preparation.root}/${
      guest.sha256 === manifest.preparation.artifact.sha256 ? "artifact" : `runtime/${guest.sha256}`
    }`;
    // A reset mid-upload leaves a truncated archive. Upload it again; the guest
    // preparation still refuses an archive whose digest does not match.
    const staged = await e2bPythonResult(
      sandbox.commands.run(
        `test -d ${shellQuote(installed)} || sha256sum ${shellQuote(guest.archivePath)}`,
        { timeoutMs: PREPARE_COMMAND_TIMEOUT_MS },
      ),
    );
    stopPresence("artifact.presence");
    if (staged.exitCode !== 0 || (staged.stdout && !staged.stdout.startsWith(desired.sha256))) {
      const stopUpload = startProvisionPhase(record);
      // A guest that receives a different file fails its preparation hash check.
      await uploadFile(await sandbox.uploadUrl(guest.archivePath), desired.path, size);
      stopUpload("artifact.upload", { bytes: size });
    }
    const stopPrepare = startProvisionPhase(record);
    const result = await prepareRemoteHost(
      transport,
      guestInput(operation, sandboxId, manifest, runtime ? { runtime: guest } : {}),
      record,
    );
    stopPrepare("remote.prepare");
    if (
      result.artifactSha256 !== desired.sha256 ||
      result.t3Revision !== desired.revision ||
      result.projectDir !== `${manifest.preparation.root}/workspace`
    )
      throw new Error("Prepared runtime does not match the pinned artifact and workspace.");
    await verifyRetentionDeadline(operation.request.retentionDeadline, {
      read: async () => (await verify(operation, sandboxId)).endAt,
      shorten: (timeoutMs) => sandbox.setTimeout(timeoutMs),
    });
    return result;
  };
  return {
    retainImportedLease: async (lease: {
      readonly sandboxId: string;
      readonly providerInstanceId: string;
    }) => {
      const info = await client.Sandbox.getInfo(lease.sandboxId);
      if (
        info.sandboxId !== lease.sandboxId ||
        info.metadata.purpose !== "t3-environment" ||
        info.metadata.account !== lease.providerInstanceId
      )
        throw new Error("The imported sandbox lease does not match this provider resource.");
      await client.Sandbox.setTimeout(lease.sandboxId, 6 * 3_600_000);
    },
    dispose: async (operation: ProvisionOperation, sandboxId: string) => {
      try {
        await verify(operation, sandboxId);
        await client.Sandbox.kill(sandboxId);
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error;
      }
    },
    prepare,
    /**
     * Converges a woken box on its preparation. A box whose T3 server still
     * answers only fetches its followed branch. One whose server died while
     * the sandbox stayed up is prepared again, which restarts the server under
     * the same environment identity. `envdUnprotected` says why envd's memory
     * could not be protected, or null.
     */
    resume: async (
      operation: ProvisionOperation,
      sandboxId: string,
      manifest: ProvisionPreparationManifest,
      runtime: ProvisionRuntimeArtifact | null,
    ) => {
      const sandbox = await connect(operation, sandboxId);
      const [checked, envdUnprotected] = await Promise.all([
        checkRemoteHost(e2bPythonPort(sandbox), guestInput(operation, sandboxId, manifest)),
        protectEnvd(sandbox),
      ]);
      if (checked.serverReady)
        return { refreshError: checked.refreshError, restarted: false, envdUnprotected };
      const ready = await prepare(operation, sandboxId, manifest, undefined, runtime);
      return { refreshError: ready.refreshError ?? null, restarted: true, envdUnprotected };
    },
    attach: async (
      operation: ProvisionOperation,
      sandboxId: string,
      manifest: ProvisionPreparationManifest,
      record?: RecordProvisionPhase,
    ) => {
      const sandbox = await connect(operation, sandboxId);
      const stopPairing = startProvisionPhase(record);
      const result = await e2bPythonPort(sandbox).executePython({
        script: String.raw`
import base64, contextlib, fcntl, json, os, pathlib, subprocess, sys, time, urllib.request
${brokerTokenScript}
spec = json.load(sys.stdin)
origin = 'http://127.0.0.1:' + str(spec['port'])
try:
    urllib.request.urlopen(origin + '/.well-known/t3/environment', timeout=5).close()
except OSError:
    print(json.dumps({'serving': False}))
    sys.exit(0)
token = broker_token(pathlib.Path(spec['root']))
request = urllib.request.Request(origin + '/api/auth/pairing-token', data=json.dumps({'label':'Cloud environment client'}).encode(), headers={'Authorization':'Bearer ' + token, 'Content-Type':'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    print(json.dumps({'serving': True, 'credential': json.load(response)['credential'], 'brokerToken': token}))
`,
        stdin: JSON.stringify({ root: manifest.preparation.root, port: manifest.preparation.port }),
      });
      stopPairing("attach.pairing");
      if (result.exitCode !== 0) throw new Error(result.stderr || "E2B pairing failed");
      const pairing = pairingResponse(result.stdout);
      if (!pairing.serving) throw new GuestNotServing();
      const { credential, brokerToken } = pairing;
      const origin = `https://${sandbox.getHost(manifest.preparation.port)}`;
      return {
        pairingUrl: `${origin}/pair#token=${encodeURIComponent(credential)}`,
        remoteAccess: { origin, brokerToken },
      };
    },
    /**
     * Turns a ready warm base build into what its snapshot should hold.
     *
     * A box restored from a snapshot pages its memory in on demand, and a
     * build leaves gigabytes of page cache that made every restore slow. So
     * the sealed build drops its cache and rehearses a chat's start, which
     * reads back only what a chat reads, before it is sealed for good.
     */
    seal: async (
      operation: ProvisionOperation,
      sandboxId: string,
      manifest: ProvisionPreparationManifest,
    ) => {
      const port = e2bPythonPort(await connect(operation, sandboxId));
      const seal = () =>
        sealWarmBase(port, {
          root: manifest.preparation.root,
          files: manifest.preparation.files.map(({ scope, destination }) => ({
            scope,
            destination,
          })),
          homePaths: warmSealHomePaths(),
        });
      // Best effort: a base that kept its memory is only slower to restore.
      const trim = (script: string) =>
        port.executePython({ script, stdin: "" }).catch(() => undefined);
      await seal();
      await trim(dropPageCacheScript);
      await prepare(operation, sandboxId, manifest);
      await seal();
      await trim(zeroFreeMemoryScript);
    },
    /** Snapshots a sealed build, reusing the snapshot an interrupted call already took. */
    snapshot: async (operation: ProvisionOperation, sandboxId: string) => {
      await verify(operation, sandboxId);
      const [taken] = await client.Sandbox.listSnapshots({ sandboxId }).nextItems();
      const { snapshotId } = taken ?? (await client.Sandbox.createSnapshot(sandboxId));
      // A snapshot id is `<template>:<tag>`; a sandbox is created from the bare template.
      return { snapshotId, templateId: snapshotId.replace(/:.*$/, "") };
    },
    /** Every snapshot taken from a sandbox. */
    snapshotsOf: async (sandboxId: string) => {
      const paginator = client.Sandbox.listSnapshots({ sandboxId });
      const snapshotIds: string[] = [];
      while (paginator.hasNext)
        for (const { snapshotId } of await paginator.nextItems()) snapshotIds.push(snapshotId);
      return snapshotIds;
    },
    /** E2B refuses to delete a snapshot while any sandbox made from it still exists. */
    deleteSnapshot: async (snapshotId: string): Promise<"deleted" | "missing" | "in_use"> => {
      try {
        return (await client.Sandbox.deleteSnapshot(snapshotId)) ? "deleted" : "missing";
      } catch (error) {
        if (error instanceof SandboxError && /sandboxes using it/.test(error.message))
          return "in_use";
        throw error;
      }
    },
    /**
     * Backs a box up while it is awake, or answers null when it is not. It never resumes a box
     * and never extends its life: one look at its state, then one connection made with the
     * timeout it already has, and every command on it ends by `deadline`. So once the backup
     * returns, nothing of it can reach the box, and a pause after it stays paused.
     */
    backUp: async (
      operation: ProvisionOperation,
      sandboxId: string,
      manifest: ProvisionPreparationManifest,
      input: Omit<Parameters<typeof backUpBox>[1], "root" | "deadline">,
      deadline: number,
    ) => {
      const sandbox = await connectAwake(operation, sandboxId, deadline);
      if (!sandbox) return null;
      return backUpBox(e2bPythonPort(sandbox, deadline), {
        ...input,
        root: manifest.preparation.root,
        deadline,
      });
    },
    /**
     * Boots a paused box fresh from its saved disk, dropping the memory E2B captured, for a box
     * whose restore E2B cannot place. E2B refuses that while another start of the box is in
     * flight, so it first waits, up to five minutes, until E2B reports the box paused; a box that
     * came up meanwhile is left as it is. One attempt, with a long timeout, and no retry.
     */
    reboot: async (operation: ProvisionOperation, sandboxId: string) => {
      const settleBy = Date.now() + 5 * 60_000;
      for (;;) {
        const { state } = await verify(operation, sandboxId, 10_000);
        if (state === "running") return;
        if (state === "paused") break;
        if (Date.now() > settleBy) throw new Error(`E2B still reports the box ${String(state)}.`);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      await client.Sandbox.connect(sandboxId, {
        onResume: "reboot",
        timeoutMs: retentionTimeoutMs(operation.request.retentionDeadline, 3_600_000),
        requestTimeoutMs: 10 * 60_000,
      });
    },
    /** Runs guest scripts on a box, resuming it first when it sleeps. */
    guest: async (operation: ProvisionOperation, sandboxId: string) =>
      e2bPythonPort(await connect(operation, sandboxId)),
    /** Reads whether an awake box may keep its memory when it pauses. Null for a box not awake. */
    probeHealth: async (operation: ProvisionOperation, sandboxId: string) => {
      const sandbox = await connectAwake(operation, sandboxId, Date.now() + 15_000).catch(
        (error: unknown) => {
          if (error instanceof SandboxNotFoundError) return null;
          throw error;
        },
      );
      if (!sandbox) return null;
      return readBoxHealth({
        // Longer than the probe waits, so the probe's own limit is what calls envd unresponsive.
        answered: sandbox.commands.run("true", { timeoutMs: 10_000, requestTimeoutMs: 10_000 }),
        samples: (start) =>
          client.Sandbox.getMetrics(sandboxId, { start, requestTimeoutMs: 5_000 }),
      });
    },
    touch: async (operation: ProvisionOperation, sandboxId: string) => {
      try {
        await connect(operation, sandboxId);
        return "running" as const;
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return "missing" as const;
        throw error;
      }
    },
  };
}
