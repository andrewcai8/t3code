// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalFetch:off - this adapter owns private CLI files and subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createClient, createGlobalTransport, createRegionTransport } from "@namespacelabs/sdk/api";
import { extractClaims } from "@namespacelabs/sdk/auth";
import { ComputeService } from "@namespacelabs/sdk/proto/namespace/cloud/compute/v1beta/compute_pb";
import { ArtifactsService } from "@namespacelabs/sdk/proto/namespace/cloud/storage/v1beta/artifact_pb";
import { DevBoxService } from "@namespacelabs/sdk/proto/namespace/private/devbox/devbox_pb";
import type { ProvisionOperation, ProvisionResource } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ProvisionRetentionError } from "./retention.ts";
import {
  namespaceResourceMatches,
  namespaceTokenSource,
  resolveNamespaceIdentity,
} from "./namespaceAllocation.ts";
import type { NamespaceResource as ImportedNamespaceResource } from "./namespaceProvisioner.ts";
import { NamespaceProxyManager, type NamespaceProxyLease } from "./namespaceProxy.ts";
import { withGuestProviderInstall } from "./guestProviderInstall.ts";
import { prepareRemoteHost, type RemotePreparationPort } from "./remotePreparation.ts";
import { startProvisionPhase, type RecordProvisionPhase } from "./provisionTiming.ts";
import type { ProvisionRuntimeArtifact } from "./config.ts";
import {
  desiredRuntime,
  followedBranch,
  provisionDigest,
  type ProvisionPreparationManifest,
} from "./ProvisionPreparation.ts";

type NamespaceResource = Extract<ProvisionResource, { provider: "namespace" }>;
interface CliCommand {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}
type CliResult = { readonly exitCode: number; readonly stdout: string; readonly stderr?: string };
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodePairing = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String, brokerToken: Schema.String })),
);
const decodeExposure = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ urls: Schema.Array(Schema.Struct({ url: Schema.String })) }),
  ),
);
const decodeDescriptor = Schema.decodeUnknownSync(Schema.Struct({ environmentId: Schema.String }));
const isNotFound = Schema.is(Schema.Struct({ code: Schema.Literal(5) }));
const decodeExpiry = Schema.decodeUnknownSync(
  Schema.Struct({ exp: Schema.optional(Schema.Finite) }),
);

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
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (data: string) => {
      stdout += data;
    });
    child.stderr.setEncoding("utf8").on("data", (data: string) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      command.signal?.removeEventListener("abort", abort);
      if (aborted) reject(new Error("Namespace CLI command aborted or timed out"));
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * The private token file binds CLI execution to the same actor and tenant as
 * the SDK. Without an explicit token each issue rereads the user token file, so
 * the session and every CLI call follow a credential refreshed in place.
 */
export async function makeNamespaceAccountSession(config: {
  readonly stateDir: string;
  readonly token?: string;
  readonly cli?: string;
  readonly apiUrl?: string;
  readonly computeApiUrl?: string;
  readonly artifactsApiUrl?: string;
  readonly commandTimeoutMs?: number;
  readonly execute?: (command: CliCommand) => Promise<CliResult>;
}) {
  const source = namespaceTokenSource(config.token);
  const identity = await resolveNamespaceIdentity(await source.issueToken(60_000));
  /**
   * A bearer token file is returned as is, whatever duration is asked for, so
   * its expiry is checked here: a call must not start on a token that dies
   * before the call can finish.
   */
  const verifiedToken = async (duration: number, force?: boolean) => {
    const token = await source.issueToken(duration, force);
    const current = await resolveNamespaceIdentity(token);
    if (current.creator !== identity.creator || current.tenantId !== identity.tenantId)
      throw new Error("Namespace account changed during the operation");
    const { exp } = decodeExpiry(extractClaims(token));
    if (
      exp !== undefined &&
      exp * 1000 - (await Effect.runPromise(Clock.currentTimeMillis)) < duration
    )
      throw new Error(
        `Namespace credential expires within the ${Math.ceil(duration / 1000)}s this call needs; refresh the Namespace token`,
      );
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
  const artifacts = createClient(
    ArtifactsService,
    createGlobalTransport({
      tokenSource: { issueToken: verifiedToken },
      baseUrl: config.artifactsApiUrl ?? "https://ord.storage.namespaceapis.com",
    }),
  );
  const run = async (args: ReadonlyArray<string>, signal?: AbortSignal, timeoutMs?: number) => {
    await NodeFSP.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
    const directory = await NodeFSP.mkdtemp(NodePath.join(config.stateDir, "namespace-cli-"));
    try {
      const limitMs = timeoutMs ?? config.commandTimeoutMs ?? 300_000;
      const tokenFile = NodePath.join(directory, "token.json");
      // The CLI holds this token for the whole command, up to its timeout.
      await NodeFSP.writeFile(
        tokenFile,
        encodeJson({ bearer_token: await verifiedToken(limitMs) }),
        { mode: 0o600 },
      );
      const timeout = AbortSignal.timeout(limitMs);
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
    artifacts,
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
import os,pathlib,re,sys
script,payload,applications=sys.argv[1:]
# The qualified image includes a beta, which can be the machine-wide default.
# Keep preparation and its backend/provider children on the qualified Xcode.
xcodes=[]
for app in pathlib.Path(applications).glob('Xcode_26.4*.app'):
    match=re.fullmatch(r'Xcode_(26\.4(?:\.\d+)?)\.app',app.name)
    developer=app/'Contents/Developer'
    if match and (developer/'Library/PrivateFrameworks/SimulatorKit.framework').is_dir():
        xcodes.append((tuple(map(int,match.group(1).split('.'))),developer))
if not xcodes:
    raise RuntimeError('Namespace image is missing the qualified Xcode 26.4.x simulator toolchain')
os.environ['DEVELOPER_DIR']=str(max(xcodes)[1])
os.chmod(script,0o600)
os.chmod(payload,0o600)
with open(payload,'rb') as data:
    os.dup2(data.fileno(),0)
    os.execv(sys.executable,[sys.executable,script])
`;
const removeStaging = "import shutil,sys; shutil.rmtree(sys.argv[1])";

async function successful(session: NamespaceAccountSession, args: ReadonlyArray<string>) {
  const result = await session.run(args);
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || "Namespace CLI command failed",
    );
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
        return await config.session.run(
          [
            "exec",
            id,
            "--",
            "python3",
            "-c",
            runUploadedPython,
            `${remote}/script.py`,
            `${remote}/input.json`,
            "/Applications",
          ],
          undefined,
          1_200_000,
        );
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
  readonly proxies?: Pick<NamespaceProxyManager, "open" | "restore" | "close">;
}) {
  const proxies = config.proxies ?? new NamespaceProxyManager();
  const ingressAuthorization =
    config.getIngressAuthorization ??
    (async () => `Bearer ${await config.session.issueToken(60_000)}`);
  /** Origins this process handed out, so a repeat attach keeps the one a client already holds. */
  const published = new Map<string, NamespaceProxyLease>();
  const publishing = new Map<string, Promise<NamespaceProxyLease>>();
  const retain = async (instanceId: string, retentionDeadline?: string) => {
    try {
      const compute = config.session.compute;
      const describe = async () => {
        const { metadata } = await compute.describeInstance({ instanceId }, { timeoutMs: 30_000 });
        if (
          !metadata ||
          metadata.instanceId !== instanceId ||
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
          instanceId,
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
        // Namespace caps an instance at creation + 5h, so accept any deadline that did not shrink.
        if (acknowledged <= now || acknowledged < before)
          throw new Error("Namespace did not extend the captured instance deadline");
        if ((await describe()) < acknowledged)
          throw new Error("Namespace instance deadline readback did not confirm extension");
      }
    } catch (error) {
      if (retentionDeadline !== undefined) throw new ProvisionRetentionError();
      throw error;
    }
  };
  /**
   * The Devbox record is the durable identity. Its instance is whichever
   * activation is running now: a shutdown destroys one and the next exec
   * starts another, so the instance captured at allocation is not compared.
   */
  const assertResource = async (operation: ProvisionOperation, resource: NamespaceResource) => {
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
      response.devbox.workspaceDir !== resource.workspaceDir
    )
      throw new Error("Namespace resource no longer matches the persisted allocation");
    return { devbox: response.devbox, instanceId: response.instanceId || undefined };
  };
  const running = async (operation: ProvisionOperation, resource: NamespaceResource) => {
    const { instanceId } = await assertResource(operation, resource);
    if (!instanceId) throw new Error("Namespace instance is not running");
    return instanceId;
  };
  /** A shut-down Devbox keeps its record and volume; any exec activates it again. */
  const wake = async (operation: ProvisionOperation, resource: NamespaceResource) => {
    const observed = await assertResource(operation, resource);
    if (observed.instanceId) return observed.instanceId;
    await successful(config.session, ["exec", resource.devboxId, "--", "true"]);
    return running(operation, resource);
  };
  const port = (resource: NamespaceResource, manifest: ProvisionPreparationManifest) =>
    namespacePythonPort({
      session: config.session,
      resource,
      root: manifest.preparation.root,
      localDir: config.stateDir,
    });
  const stageArtifact = async (
    resource: NamespaceResource,
    manifest: ProvisionPreparationManifest,
    desired: ProvisionRuntimeArtifact,
    guest: ProvisionPreparationManifest["preparation"]["artifact"],
    record?: RecordProvisionPhase,
  ) => {
    const stopDigest = startProvisionPhase(record);
    const archive = await NodeFSP.readFile(desired.path);
    if (provisionDigest(archive) !== desired.sha256)
      throw new Error("The stored runtime artifact changed");
    stopDigest("artifact.digest", { bytes: archive.byteLength });
    const id = resource.devboxId;
    // The archive lives on the retained volume, so a resume or a retried
    // preparation skips the upload once its digest checks out.
    const stopPresence = startProvisionPhase(record);
    const presence = await successful(config.session, [
      "exec",
      id,
      "--",
      "python3",
      "-c",
      String.raw`
import hashlib,pathlib,sys
target,expected=sys.argv[1:]
target=pathlib.Path(target)
if not target.exists(): print('missing')
elif target.is_symlink() or not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest()!=expected: raise RuntimeError('Existing artifact conflicts')
else: print('present')
`,
      guest.archivePath,
      desired.sha256,
    ]);
    stopPresence("artifact.presence");
    if (presence.trim() === "present") return;
    const staged = `${manifest.preparation.root}/artifact-${NodeCrypto.randomUUID()}`;
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
      const stopUpload = startProvisionPhase(record);
      await successful(config.session, ["upload", id, desired.path, `${staged}/runtime.tar`]);
      stopUpload("artifact.upload", { bytes: archive.byteLength });
      const stopLink = startProvisionPhase(record);
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
        guest.archivePath,
        desired.sha256,
      ]);
      stopLink("artifact.link");
    } finally {
      await config.session
        .run(["exec", id, "--", "python3", "-c", removeStaging, staged])
        .catch(() => undefined);
    }
  };
  /** A signed download URL per configured artifact, fresh for this attempt; the guest fetches the bytes itself. */
  const resolveArtifactSources = async (
    manifest: ProvisionPreparationManifest,
    record?: RecordProvisionPhase,
  ) => {
    const artifacts = manifest.preparation.artifacts ?? [];
    if (artifacts.length === 0) return [];
    const stopResolve = startProvisionPhase(record);
    const sources = [];
    for (const { path } of artifacts) {
      const { signedDownloadUrl } = await config.session.artifacts.resolveArtifact(
        { namespace: "main", path },
        { timeoutMs: 30_000 },
      );
      const url = URL.parse(signedDownloadUrl);
      if (!url || url.protocol !== "https:" || url.username || url.password)
        throw new Error("Namespace artifact requires a private HTTPS download URL");
      sources.push({ path, url: url.href });
    }
    stopResolve("artifact.resolve", { count: sources.length });
    return sources;
  };
  /**
   * Converges the Mac on the manifest: wakes it if shut down, stages the
   * archive once, and runs the remote preparation, which keeps an intact root's
   * environment ID and files and relaunches the server only when it is down.
   */
  const prepare = async (
    operation: ProvisionOperation,
    resource: NamespaceResource,
    manifest: ProvisionPreparationManifest,
    record?: RecordProvisionPhase,
    runtime: ProvisionRuntimeArtifact | null = null,
  ) => {
    const { local: desired, guest } = desiredRuntime(manifest, runtime);
    const stopWake = startProvisionPhase(record);
    const instanceId = await wake(operation, resource);
    stopWake("allocate.wake");
    if (operation.request.retentionDeadline) {
      const stopRetain = startProvisionPhase(record);
      await retain(instanceId, operation.request.retentionDeadline);
      stopRetain("allocate.retain");
    }
    await stageArtifact(resource, manifest, desired, guest, record);
    const artifactSources = await resolveArtifactSources(manifest, record);
    const follow = followedBranch(manifest);
    const stopPrepare = startProvisionPhase(record);
    const ready = await prepareRemoteHost(
      port(resource, manifest),
      withGuestProviderInstall(
        {
          ...manifest.preparation,
          resourceIdentity: `namespace:${resource.devboxId}`,
          requestHash: operation.requestHash,
          preparationHash: operation.request.preparationHash,
          ...(artifactSources.length ? { artifactSources } : {}),
          ...(runtime ? { runtime: guest } : {}),
          ...(follow ? { follow } : {}),
        },
        operation.request.agentDriver,
      ),
      record,
    );
    stopPrepare("remote.prepare");
    if (
      ready.artifactSha256 !== desired.sha256 ||
      ready.t3Revision !== desired.revision ||
      ready.projectDir !== `${manifest.preparation.root}/workspace`
    )
      throw new Error("Prepared Namespace runtime differs from its pinned inputs");
    if (operation.request.retentionDeadline) {
      const stopRetain = startProvisionPhase(record);
      await retain(instanceId, operation.request.retentionDeadline);
      stopRetain("allocate.retain");
    }
    return ready;
  };
  /**
   * Exposes the guest's T3 port and serves it on a loopback proxy. A recorded
   * lease re-binds the origin a client already holds; the exposure is fetched
   * fresh every time because a woken Mac may publish a new upstream.
   */
  const publish = (
    operation: ProvisionOperation,
    resource: NamespaceResource,
    manifest: ProvisionPreparationManifest,
    recorded?: NamespaceProxyLease,
    record?: RecordProvisionPhase,
  ) => {
    if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
    const environmentId = operation.state.readiness.environmentId;
    const proxyId = `provision-${operation.request.requestId}`;
    let pending = publishing.get(proxyId);
    if (pending) return pending;
    pending = (async () => {
      const stopExpose = startProvisionPhase(record);
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
      stopExpose("attach.expose");
      const upstream = decodeExposure(output).urls[0]?.url;
      if (!upstream || new URL(upstream).protocol !== "https:")
        throw new Error("Namespace exposure did not return a private HTTPS endpoint");
      const input = {
        proxyId,
        upstreamHttpBaseUrl: upstream,
        upstreamWsBaseUrl: upstream.replace(/^https:/, "wss:"),
        // A proxy outlives any single token, so it asks for one per request
        // rather than pinning the one it opened with.
        getUpstreamAuthorization: ingressAuthorization,
      };
      const retained = recorded ?? published.get(proxyId);
      const stopProxy = startProvisionPhase(record);
      const lease = retained
        ? await proxies.restore({ ...input, ...retained })
        : await proxies.open(input);
      stopProxy("attach.proxy");
      published.set(proxyId, lease);
      try {
        const stopVerify = startProvisionPhase(record);
        const response = await fetch(`${lease.proxyOrigin}/.well-known/t3/environment`, {
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
        stopVerify("attach.verify");
        if (descriptor.environmentId !== environmentId)
          throw new Error("Namespace published endpoint returned a different T3 environment");
      } catch (error) {
        await proxies.close({ proxyId });
        throw error;
      }
      return lease;
    })().finally(() => publishing.delete(proxyId));
    publishing.set(proxyId, pending);
    return pending;
  };
  return {
    prepare,
    attach: async (
      operation: ProvisionOperation,
      resource: NamespaceResource,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      record?: RecordProvisionPhase,
    ) => {
      await running(operation, resource);
      if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
      const environmentId = operation.state.readiness.environmentId;
      const stopPairing = startProvisionPhase(record);
      const result = await port(resource, manifest).executePython({
        script: String.raw`
import json,pathlib,sys,urllib.request
spec=json.load(sys.stdin)
origin='http://127.0.0.1:'+str(spec['port'])
with urllib.request.urlopen(origin+'/.well-known/t3/environment',timeout=10) as response:
    if json.load(response)['environmentId']!=spec['environmentId']: raise RuntimeError('Environment identity changed')
token=pathlib.Path(spec['root'],'broker-token').read_text()
request=urllib.request.Request(origin+'/api/auth/pairing-token',data=json.dumps({'label':'Cloud environment client'}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=30) as response: print(json.dumps({'credential':json.load(response)['credential'],'brokerToken':token}))
`,
        stdin: encodeJson({
          root: manifest.preparation.root,
          port: manifest.preparation.port,
          environmentId,
        }),
      });
      stopPairing("attach.pairing");
      if (result.exitCode !== 0) throw new Error("Namespace pairing failed");
      const { credential, brokerToken } = decodePairing(result.stdout);
      const namespaceProxy = await publish(operation, resource, manifest, recordedProxy, record);
      return {
        pairingUrl: `${namespaceProxy.proxyOrigin}/pair#token=${encodeURIComponent(credential)}`,
        namespaceProxy,
        remoteAccess: { origin: namespaceProxy.proxyOrigin, brokerToken },
      };
    },
    /**
     * Brings a paused or orphaned environment back at the origin its client
     * saved: wake, converge the retained root, then publish through the proxy.
     */
    resume: async (
      operation: ProvisionOperation,
      resource: NamespaceResource,
      manifest: ProvisionPreparationManifest,
      recordedProxy?: NamespaceProxyLease,
      runtime: ProvisionRuntimeArtifact | null = null,
    ) => {
      if (operation.state.kind !== "ready") throw new Error("Namespace environment is not ready");
      const ready = await prepare(operation, resource, manifest, undefined, runtime);
      if (ready.environmentId !== operation.state.readiness.environmentId)
        throw new Error("Namespace retained environment identity changed");
      return publish(operation, resource, manifest, recordedProxy);
    },
    touch: async (operation: ProvisionOperation, resource: NamespaceResource) => {
      // Only a vanished Devbox record is "missing". A record with no instance
      // is a shutdown machine, which is an error here as it always was.
      const instanceId = await running(operation, resource).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (instanceId === null) return "missing" as const;
      await retain(instanceId, operation.request.retentionDeadline);
      return "running" as const;
    },
    /**
     * Only the registry's imported legacy lease IDs may call this
     * operation-independent path. Those Macs were all created private under a
     * user login, so a credential with no actor cannot own them.
     */
    retainImportedLease: async (resource: ImportedNamespaceResource) => {
      if (config.session.identity.creator === undefined)
        throw new Error("Imported Namespace leases need the user login that created them");
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
      await retain(response.instanceId);
    },
    dispose: async (operation: ProvisionOperation, resource: NamespaceResource) => {
      const proxyId = `provision-${operation.request.requestId}`;
      await publishing.get(proxyId)?.catch(() => undefined);
      await proxies.close({ proxyId });
      published.delete(proxyId);
      const observed = await assertResource(operation, resource).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (observed === null) return;
      if (observed.instanceId)
        await successful(config.session, ["shutdown", resource.devboxId, "--force"]);
      // The provider may already have removed the Devbox with its shutdown.
      const remaining = await assertResource(operation, resource).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      });
      if (remaining !== null)
        await successful(config.session, ["expire", resource.devboxId, "--force"]);
    },
  };
}
