// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalFetch:off - this adapter owns private CLI files and subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { fromBearerToken, loadUserToken } from "@namespacelabs/sdk/auth";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import type { ProvisionOperation, ProvisionResource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProvisionRetentionError } from "./retention.ts";
import { namespaceResourceMatches, resolveNamespaceIdentity } from "./namespaceAllocation.ts";
import type { NamespaceResource as ImportedNamespaceResource } from "./namespaceProvisioner.ts";
import { NamespaceProxyManager } from "./namespaceProxy.ts";
import { prepareRemoteHost, type RemotePreparationPort } from "./remotePreparation.ts";
import { provisionDigest, type ProvisionPreparationManifest } from "./ProvisionPreparation.ts";

type NamespaceResource = Extract<ProvisionResource, { provider: "namespace" }>;
interface CliCommand {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}
type CliResult = { readonly exitCode: number; readonly stdout: string };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePairing = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);
const decodeExposure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ urls: Schema.Array(Schema.Struct({ url: Schema.String })) }),
  ),
);
const decodeDescriptor = Schema.decodeUnknownSync(Schema.Struct({ environmentId: Schema.String }));
const isNotFound = Schema.is(Schema.Struct({ code: Schema.Literal(5) }));

function executeCli(binary: string, command: CliCommand): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(binary, [...command.args], {
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let aborted = false;
    const abort = () => {
      if (aborted || child.exitCode !== null || child.signalCode !== null) return;
      aborted = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    };
    command.signal?.addEventListener("abort", abort, { once: true });
    if (command.signal?.aborted) abort();
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", (code) => {
      command.signal?.removeEventListener("abort", abort);
      if (aborted) reject(new Error("Namespace CLI command aborted or timed out"));
      else resolve({ exitCode: code ?? 1, stdout });
    });
  });
}

/** The private token file binds CLI execution to the same actor and tenant as the SDK. */
export async function makeNamespaceAccountSession(config: {
  readonly stateDir: string;
  readonly token?: string;
  readonly cli?: string;
  readonly apiUrl?: string;
  readonly computeApiUrl?: string;
  readonly commandTimeoutMs?: number;
  readonly execute?: (command: CliCommand) => Promise<CliResult>;
}) {
  const source = config.token ? fromBearerToken(config.token) : await loadUserToken();
  const identity = await resolveNamespaceIdentity(await source.issueToken(60_000));
  const verifiedToken = async (duration: number, force?: boolean) => {
    const token = await source.issueToken(duration, force);
    const current = await resolveNamespaceIdentity(token);
    if (current.creator !== identity.creator || current.tenantId !== identity.tenantId)
      throw new Error("Namespace account changed during the operation");
    return token;
  };
  const client = createClient(
    DevBoxService,
    createGlobalTransport({
      tokenSource: { issueToken: verifiedToken },
      baseUrl: config.apiUrl ?? "https://private-api.global.namespaceapis.com",
    }),
  );
  // Devbox sites (for example iad) do not name Compute API regions. This is the CLI default.
  const compute = createClient(
    ComputeService,
    createRegionTransport("eu", {
      tokenSource: { issueToken: verifiedToken },
      ...(config.computeApiUrl ? { baseUrl: config.computeApiUrl } : {}),
    }),
  );
  const run = async (args: ReadonlyArray<string>, signal?: AbortSignal) => {
    await NodeFSP.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const directory = await NodeFSP.mkdtemp(NodePath.join(config.stateDir, "namespace-cli-"));
    try {
      const tokenFile = NodePath.join(directory, "token.json");
      await NodeFSP.writeFile(
        tokenFile,
        encodeJson({ bearer_token: await verifiedToken(60_000) }),
        { mode: 0o600 },
      );
      const timeout = AbortSignal.timeout(config.commandTimeoutMs ?? 300_000);
      const command = {
        args,
        env: { ...process.env, NSC_TOKEN_FILE: tokenFile },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      };
      return await (config.execute
        ? config.execute(command)
        : executeCli(config.cli ?? "devbox", command));
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  };
  // The API clients re-verify the account on every call. The proxy does not
  // need to: its identity was checked when this session opened, and paying for
  // a second round trip on every proxied request is what made it time out.
  return {
    identity,
    client,
    compute,
    run,
    issueToken: (duration: number, force?: boolean) => source.issueToken(duration, force),
  };
}
type NamespaceAccountSession = Awaited<ReturnType<typeof makeNamespaceAccountSession>>;

const prepareDirectory = String.raw`
import os,pathlib,sys
os.umask(0o077)
root=pathlib.Path(sys.argv[1])
root.mkdir(parents=True,exist_ok=True,mode=0o700)
if root.is_symlink() or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
    raise RuntimeError('Remote staging root must be private')
pathlib.Path(sys.argv[2]).mkdir(mode=0o700)
`;
const runUploadedPython = String.raw`
import os,sys
script,payload=sys.argv[1:]
os.chmod(script,0o600)
os.chmod(payload,0o600)
with open(payload,'rb') as data:
    os.dup2(data.fileno(),0)
    os.execv(sys.executable,[sys.executable,script])
`;
const removeStaging = "import shutil,sys; shutil.rmtree(sys.argv[1])";

async function successful(session: NamespaceAccountSession, args: ReadonlyArray<string>) {
  const result = await session.run(args);
  if (result.exitCode !== 0) throw new Error("Namespace CLI command failed");
  return result.stdout;
}

/** Uploads private files instead of assuming that devbox exec forwards stdin. */
export function namespacePythonPort(config: {
  readonly session: NamespaceAccountSession;
  readonly resource: NamespaceResource;
  readonly root: string;
  readonly localDir: string;
}): RemotePreparationPort {
  return {
    executePython: async ({ script, stdin }) => {
      await NodeFSP.mkdir(config.localDir, { recursive: true, mode: 0o700 });
      const local = await NodeFSP.mkdtemp(NodePath.join(config.localDir, "namespace-input-"));
      const remote = `${config.root}/input-${NodeCrypto.randomUUID()}`;
      const id = config.resource.devboxId;
      let staged = false;
      try {
        await successful(config.session, [
          "exec",
          id,
          "--",
          "python3",
          "-c",
          prepareDirectory,
          config.root,
          remote,
        ]);
        staged = true;
        for (const { name, contents } of [
          { name: "script.py", contents: script },
          { name: "input.json", contents: stdin },
        ]) {
          const file = NodePath.join(local, name);
          await NodeFSP.writeFile(file, contents, { mode: 0o600 });
          await successful(config.session, ["upload", id, file, `${remote}/${name}`]);
        }
        return await config.session.run([
          "exec",
          id,
          "--",
          "python3",
          "-c",
          runUploadedPython,
          `${remote}/script.py`,
          `${remote}/input.json`,
        ]);
      } finally {
        if (staged)
          await config.session
            .run(["exec", id, "--", "python3", "-c", removeStaging, remote])
            .catch(() => undefined);
        await NodeFSP.rm(local, { recursive: true, force: true });
      }
    },
  };
}

export function makeNamespaceProvisionRuntime(config: {
  readonly session: NamespaceAccountSession;
  readonly stateDir: string;
  /** Supplies the proxy's upstream credential, so it can be renewed or stubbed. */
  readonly getIngressAuthorization?: () => Promise<string>;
  readonly proxies?: Pick<NamespaceProxyManager, "open" | "close">;
}) {
  const proxies = config.proxies ?? new NamespaceProxyManager();
  const ingressAuthorization =
    config.getIngressAuthorization ??
    (async () => `Bearer ${await config.session.issueToken(60_000)}`);
  const openProxies = new Map<string, Promise<string>>();
  const retain = async (resource: NamespaceResource, retentionDeadline?: string) => {
    try {
      const compute = config.session.compute;
      const describe = async () => {
        const { metadata } = await compute.describeInstance(
          { instanceId: resource.instanceId },
          { timeoutMs: 30_000 },
        );
        if (
          !metadata ||
          metadata.instanceId !== resource.instanceId ||
          metadata.destroyedAt ||
          !metadata.deadline
        )
          throw new Error("Namespace instance has no verified active deadline");
        return Number(metadata.deadline.seconds) * 1000 + metadata.deadline.nanos / 1_000_000;
      };
      const before = await describe();
      const now = await Effect.runPromise(Clock.currentTimeMillis);
      const deadline = retentionDeadline
        ? DateTime.toEpochMillis(DateTime.makeUnsafe(retentionDeadline))
        : undefined;
      if (deadline !== undefined && deadline <= now)
        throw new Error("Namespace retention deadline has expired");
      const { newDeadline } = await compute.extendInstance(
        {
          instanceId: resource.instanceId,
          ...(deadline === undefined
            ? { ensureMinimum: { seconds: 21_600n } }
            : {
                newDeadline: {
                  seconds: BigInt(Math.floor(deadline / 1000)),
                  nanos: (deadline % 1000) * 1_000_000,
                },
              }),
        },
        { timeoutMs: 30_000 },
      );
      const acknowledged = newDeadline
        ? Number(newDeadline.seconds) * 1000 + newDeadline.nanos / 1_000_000
        : 0;
      if (deadline !== undefined) {
        if (acknowledged !== deadline)
          throw new Error("Namespace did not acknowledge the exact retention deadline");
        if ((await describe()) !== deadline)
          throw new Error("Namespace instance deadline readback differs from its retention cap");
      } else {
        if (acknowledged < now + 21_600_000 || acknowledged < before)
          throw new Error("Namespace did not extend the captured instance deadline");
        if ((await describe()) < acknowledged)
          throw new Error("Namespace instance deadline readback did not confirm extension");
      }
    } catch (error) {
      if (retentionDeadline !== undefined) throw new ProvisionRetentionError();
      throw error;
    }
  };
  const assertResource = async (
    operation: ProvisionOperation,
    resource: NamespaceResource,
    allowStopped = false,
  ) => {
    const request = operation.request;
    if (
      request.provider !== "namespace" ||
      request.creator !== config.session.identity.creator ||
      request.tenantId !== config.session.identity.tenantId
    )
      throw new Error("Namespace account does not match the provisioning operation");
    const response = await config.session.client.fetch(
      { id: resource.devboxId, returnActivatedInstance: true },
      { timeoutMs: 30_000 },
    );
    if (
      !response.devbox ||
      response.devbox.id !== resource.devboxId ||
      (resource.devboxName !== undefined && response.devbox.name !== resource.devboxName) ||
      !namespaceResourceMatches(response.devbox, request) ||
      response.devbox.site !== resource.region ||
      response.devbox.workspaceDir !== resource.workspaceDir ||
      (response.instanceId !== resource.instanceId && !(allowStopped && !response.instanceId))
    )
      throw new Error("Namespace resource no longer matches the persisted allocation");
    return { devbox: response.devbox, instanceId: response.instanceId };
  };
  const port = (resource: NamespaceResource, manifest: ProvisionPreparationManifest) =>
    namespacePythonPort({
      session: config.session,
      resource,
      root: manifest.preparation.root,
      localDir: config.stateDir,
    });
  return {
    prepare: async (
      operation: ProvisionOperation,
      resource: NamespaceResource,
      manifest: ProvisionPreparationManifest,
    ) => {
      await assertResource(operation, resource);
      if (operation.request.retentionDeadline)
        await retain(resource, operation.request.retentionDeadline);
      const archive = await NodeFSP.readFile(manifest.localArtifact.path);
      if (provisionDigest(archive) !== manifest.localArtifact.sha256)
        throw new Error("The stored runtime artifact changed");
      const staged = `${manifest.preparation.root}/artifact-${NodeCrypto.randomUUID()}`;
      const id = resource.devboxId;
      await successful(config.session, [
        "exec",
        id,
        "--",
        "python3",
        "-c",
        prepareDirectory,
        manifest.preparation.root,
        staged,
      ]);
      try {
        await successful(config.session, [
          "upload",
          id,
          manifest.localArtifact.path,
          `${staged}/runtime.tar`,
        ]);
        await successful(config.session, [
          "exec",
          id,
          "--",
          "python3",
          "-c",
          String.raw`
import hashlib,os,pathlib,sys
source,target,expected=sys.argv[1:]
source=pathlib.Path(source)
target=pathlib.Path(target)
os.chmod(source,0o600)
if hashlib.sha256(source.read_bytes()).hexdigest()!=expected: raise RuntimeError('Artifact digest mismatch')
try:
    os.link(source,target)
except FileExistsError:
    if target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest()!=expected: raise RuntimeError('Existing artifact conflicts')
`,
          `${staged}/runtime.tar`,
          manifest.preparation.artifact.archivePath,
          manifest.localArtifact.sha256,
        ]);
      } finally {
        await config.session
          .run(["exec", id, "--", "python3", "-c", removeStaging, staged])
          .catch(() => undefined);
      }
      const ready = await prepareRemoteHost(port(resource, manifest), {
        ...manifest.preparation,
        resourceIdentity: `namespace:${resource.devboxId}`,
        requestHash: operation.requestHash,
        preparationHash: operation.request.preparationHash,
      });
      if (
        ready.artifactSha256 !== manifest.localArtifact.sha256 ||
        ready.t3Revision !== manifest.localArtifact.revision ||
        ready.projectDir !== `${manifest.preparation.root}/workspace`
      )
        throw new Error("Prepared Namespace runtime differs from its pinned inputs");
      if (operation.request.retentionDeadline)
        await retain(resource, operation.request.retentionDeadline);
      return ready;
    },
    attach: async (
      operation: ProvisionOperation,
      resource: NamespaceResource,
      manifest: ProvisionPreparationManifest,
    ) => {
      await assertResource(operation, resource);
      if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
      const environmentId = operation.state.readiness.environmentId;
      const result = await port(resource, manifest).executePython({
        script: String.raw`
import json,pathlib,sys,urllib.request
spec=json.load(sys.stdin)
origin='http://127.0.0.1:'+str(spec['port'])
with urllib.request.urlopen(origin+'/.well-known/t3/environment',timeout=10) as response:
    if json.load(response)['environmentId']!=spec['environmentId']: raise RuntimeError('Environment identity changed')
token=pathlib.Path(spec['root'],'broker-token').read_text()
request=urllib.request.Request(origin+'/api/auth/pairing-token',data=json.dumps({'label':'Cloud environment client'}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=30) as response: print(json.dumps(json.load(response)))
`,
        stdin: encodeJson({
          root: manifest.preparation.root,
          port: manifest.preparation.port,
          environmentId,
        }),
      });
      if (result.exitCode !== 0) throw new Error("Namespace pairing failed");
      const { credential } = decodePairing(result.stdout);
      const proxyId = `provision-${operation.request.requestId}`;
      let origin = openProxies.get(proxyId);
      if (!origin) {
        origin = (async () => {
          const output = await successful(config.session, [
            "url",
            "expose",
            resource.devboxId,
            "--port",
            String(manifest.preparation.port),
            "--access",
            "workspace",
            "-o",
            "json",
          ]);
          const upstream = decodeExposure(output).urls[0]?.url;
          if (!upstream || new URL(upstream).protocol !== "https:")
            throw new Error("Namespace exposure did not return a private HTTPS endpoint");
          return (
            await proxies.open({
              proxyId,
              upstreamHttpBaseUrl: upstream,
              upstreamWsBaseUrl: upstream.replace(/^https:/, "wss:"),
              // A proxy outlives any single token, so it asks for one per
              // request rather than pinning the one it opened with.
              getUpstreamAuthorization: ingressAuthorization,
            })
          ).proxyOrigin;
        })();
        openProxies.set(proxyId, origin);
        void origin.catch(() => openProxies.delete(proxyId));
      }
      const proxyOrigin = await origin;
      try {
        const response = await fetch(`${proxyOrigin}/.well-known/t3/environment`, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `Namespace published endpoint returned HTTP ${response.status} before T3 identity verification`,
          );
        }
        const descriptor = decodeDescriptor(await response.json());
        if (descriptor.environmentId !== environmentId)
          throw new Error("Namespace published endpoint returned a different T3 environment");
      } catch (error) {
        await proxies.close({ proxyId });
        openProxies.delete(proxyId);
        throw error;
      }
      return `${proxyOrigin}/pair#token=${encodeURIComponent(credential)}`;
    },
    touch: async (operation: ProvisionOperation, resource: NamespaceResource) => {
      await assertResource(operation, resource);
      await retain(resource, operation.request.retentionDeadline);
    },
    /** Only the registry's imported legacy lease IDs may call this operation-independent path. */
    retainImportedLease: async (resource: ImportedNamespaceResource) => {
      const response = await config.session.client.fetch(
        { id: resource.devboxId, returnActivatedInstance: true },
        { timeoutMs: 30_000 },
      );
      if (
        response.devbox?.id !== resource.devboxId ||
        (resource.devboxName !== undefined && response.devbox.name !== resource.devboxName) ||
        response.devbox.creator !== config.session.identity.creator ||
        response.devbox.site !== resource.region ||
        !response.instanceId ||
        response.instanceId !== resource.instanceId
      )
        throw new Error("Imported Namespace lease no longer belongs to the configured account");
      await retain({ ...resource, devboxName: response.devbox.name });
    },
    dispose: async (operation: ProvisionOperation, resource: NamespaceResource) => {
      const proxyId = `provision-${operation.request.requestId}`;
      await openProxies.get(proxyId)?.catch(() => undefined);
      await proxies.close({ proxyId });
      openProxies.delete(proxyId);
      const observed = await assertResource(operation, resource, true).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (observed === null) return;
      if (observed.instanceId)
        await successful(config.session, ["shutdown", resource.devboxId, "--force"]);
      // Shutting down an ephemeral Devbox may already remove it.
      const remaining = await assertResource(operation, resource, true).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (remaining !== null)
        await successful(config.session, ["expire", resource.devboxId, "--force"]);
    },
  };
}
