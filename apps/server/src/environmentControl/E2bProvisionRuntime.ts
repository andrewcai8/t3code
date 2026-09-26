// @effect-diagnostics globalFetch:off - Promise SDK adapters perform provider resolution and private remote HTTP.
// @effect-diagnostics nodeBuiltinImport:off - SDK transfers read immutable local artifacts at the provider boundary.
import * as NodeFSP from "node:fs/promises";
import {
  CommandExitError,
  E2B,
  SandboxNotFoundError,
  type CommandResult,
  type E2BClientOpts,
  type Sandbox,
} from "e2b";
import type { ProvisionOperation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { prepareRemoteHost, type RemotePreparationPort } from "./remotePreparation.ts";
import { startProvisionPhase, type RecordProvisionPhase } from "./provisionTiming.ts";
import { withGuestProviderInstall } from "./guestProviderInstall.ts";
import type { ProvisionRuntimeArtifact } from "./config.ts";
import {
  desiredRuntime,
  followedBranch,
  provisionDigest,
  type ProvisionPreparationManifest,
} from "./ProvisionPreparation.ts";

import { retentionTimeoutMs, verifyRetentionDeadline } from "./retention.ts";

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
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String, brokerToken: Schema.String })),
);
const templateResponse = Schema.decodeUnknownSync(Schema.Struct({ templateID: Schema.String }));
const revisionResponse = Schema.decodeUnknownSync(
  Schema.Struct({ sha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)) }),
);
const archivePresence = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Boolean));

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

const STDIN_CHUNK = 4 * 1024 * 1024;

function e2bPythonPort(sandbox: Sandbox): RemotePreparationPort {
  return {
    executePython: async ({ script, stdin }) => {
      if (stdin.length === 0)
        return e2bPythonResult(
          sandbox.commands.run(`python3 -c ${shellQuote(script)}`, {
            timeoutMs: PREPARE_COMMAND_TIMEOUT_MS,
          }),
        );
      const command = await sandbox.commands.run(`python3 -c ${shellQuote(script)}`, {
        background: true,
        stdin: true,
        timeoutMs: PREPARE_COMMAND_TIMEOUT_MS,
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

export function makeE2bProvisionRuntime(connection: E2BClientOpts) {
  const client = new E2B(connection);
  const verify = async (operation: ProvisionOperation, sandboxId: string) => {
    const info = await client.Sandbox.getInfo(sandboxId);
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
    const sandbox = await client.Sandbox.connect(sandboxId, {
      timeoutMs: retentionTimeoutMs(operation.request.retentionDeadline, 6 * 3_600_000),
    });
    await verifyRetentionDeadline(operation.request.retentionDeadline, {
      read: async () => (await verify(operation, sandboxId)).endAt,
      shorten: (timeoutMs) => sandbox.setTimeout(timeoutMs),
    });
    return sandbox;
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
    prepare: async (
      operation: ProvisionOperation,
      sandboxId: string,
      manifest: ProvisionPreparationManifest,
      record?: RecordProvisionPhase,
      runtime: ProvisionRuntimeArtifact | null = null,
    ) => {
      const sandbox = await connect(operation, sandboxId);
      const { local: desired, guest } = desiredRuntime(manifest, runtime);
      const stopDigest = startProvisionPhase(record);
      const archive = await NodeFSP.readFile(desired.path);
      if (provisionDigest(archive) !== desired.sha256)
        throw new Error("The stored runtime artifact changed.");
      stopDigest("artifact.digest", { bytes: archive.byteLength });
      const transport = e2bPythonPort(sandbox);
      const stopPresence = startProvisionPhase(record);
      const existingArchive = await transport.executePython({
        script: String.raw`
import hashlib, json, pathlib, stat, sys
spec = json.load(sys.stdin)
path = pathlib.Path(spec['path'])
try:
    metadata = path.lstat()
except FileNotFoundError:
    print('false')
else:
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeError('The existing runtime archive is not a regular file')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != spec['sha256']:
        raise RuntimeError('The existing runtime archive failed its content hash check')
    print('true')
`,
        stdin: JSON.stringify({ path: guest.archivePath, sha256: desired.sha256 }),
      });
      stopPresence("artifact.presence");
      if (!archivePresence(existingArchive.stdout)) {
        const stopUpload = startProvisionPhase(record);
        await sandbox.files.write(
          guest.archivePath,
          new Uint8Array(archive).buffer,
          // E2B files.write uses AbortSignal.timeout(60_000) unless overridden.
          { requestTimeoutMs: PREPARE_COMMAND_TIMEOUT_MS },
        );
        stopUpload("artifact.upload", { bytes: archive.byteLength });
      }
      const follow = followedBranch(manifest);
      const stopPrepare = startProvisionPhase(record);
      const result = await prepareRemoteHost(
        transport,
        withGuestProviderInstall(
          {
            ...manifest.preparation,
            resourceIdentity: `e2b:${sandboxId}`,
            requestHash: operation.requestHash,
            preparationHash: operation.request.preparationHash,
            ...(runtime ? { runtime: guest } : {}),
            ...(follow ? { follow } : {}),
          },
          operation.request.agentDriver,
        ),
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
import json, pathlib, sys, urllib.request
spec = json.load(sys.stdin)
token = pathlib.Path(spec['root'], 'broker-token').read_text()
request = urllib.request.Request('http://127.0.0.1:' + str(spec['port']) + '/api/auth/pairing-token', data=json.dumps({'label':'Cloud environment client'}).encode(), headers={'Authorization':'Bearer ' + token, 'Content-Type':'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    print(json.dumps({'credential': json.load(response)['credential'], 'brokerToken': token}))
`,
        stdin: JSON.stringify({ root: manifest.preparation.root, port: manifest.preparation.port }),
      });
      stopPairing("attach.pairing");
      const { credential, brokerToken } = pairingResponse(result.stdout);
      const origin = `https://${sandbox.getHost(manifest.preparation.port)}`;
      return {
        pairingUrl: `${origin}/pair#token=${encodeURIComponent(credential)}`,
        remoteAccess: { origin, brokerToken },
      };
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
