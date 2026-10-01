// @effect-diagnostics nodeBuiltinImport:off - the token-file test reads a real private directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LabelFilterEntry_LabelFilterOp } from "@namespacelabs/sdk/proto/namespace/stdlib/labels_pb";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  InstanceId,
  makeNamespaceArtifacts,
  makeNamespaceInstances,
  nscWithToken,
  type NamespaceArtifactsClient,
  type NamespaceComputeClient,
  type NscCli,
  spawnNsc,
} from "./namespaceInstances.ts";

const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const cursorAt = (index: number) => new TextEncoder().encode(String(index));
const indexOf = (cursor: Uint8Array | undefined) =>
  cursor && cursor.length > 0 ? Number(new TextDecoder().decode(cursor)) : 0;
/** One item per page, so every listing spans several pages. */
const pageOf = <T>(items: ReadonlyArray<T>, cursor: Uint8Array | undefined) => {
  const index = indexOf(cursor);
  return {
    items: items.slice(index, index + 1),
    paginationCursor: index + 1 < items.length ? cursorAt(index + 1) : new Uint8Array(),
  };
};
const matches = (
  labels: ReadonlyMap<string, string>,
  filter: ReadonlyArray<{
    readonly name?: string;
    readonly value?: string;
    readonly op?: LabelFilterEntry_LabelFilterOp;
  }>,
) =>
  filter.every(
    ({ name, value, op }) =>
      op === LabelFilterEntry_LabelFilterOp.EQUAL && labels.get(name ?? "") === value,
  );

interface FakeMac {
  readonly labels: Map<string, string>;
  deadline: unknown;
  readonly ingressDomain: string;
  destroyed: boolean;
  halted: boolean;
  volume: "attached" | "committed" | "abandoned" | null;
  readonly ingresses: Map<string, number>;
  readonly files: Map<string, string>;
}

/** Namespace Compute plus ssh, as far as the instance boundary can observe them. */
function makeMacWorld() {
  const macs = new Map<string, FakeMac>();
  const createRequests: unknown[] = [];
  const nscCalls: Array<{ readonly args: ReadonlyArray<string>; readonly stdin?: string }> = [];
  const metadata = (instanceId: string, mac: FakeMac) => ({
    instanceId,
    createdAt: { seconds: 1_790_000_000n, nanos: 250_000_000 },
    deadline: mac.deadline,
    destroyedAt: mac.destroyed ? { seconds: 1_790_000_900n, nanos: 0 } : undefined,
    status: mac.destroyed ? 4 : 3,
    ingressDomain: mac.ingressDomain,
    labels: [...mac.labels].map(([name, value]) => ({ name, value })),
  });
  const find = (instanceId: string | undefined) => {
    const mac = macs.get(instanceId ?? "");
    if (!mac) throw rpcError(5, "instance not found");
    return mac;
  };
  const compute: NamespaceComputeClient = {
    createInstance: async (request) => {
      createRequests.push(request);
      const instanceId = `mac-${macs.size + 1}`;
      const labels = new Map<string, string>();
      for (const label of request.labels ?? []) labels.set(label.name ?? "", label.value ?? "");
      const mac: FakeMac = {
        labels,
        deadline: request.deadline,
        ingressDomain: "ord4.nscluster.cloud",
        destroyed: false,
        halted: false,
        volume: (request.volumes ?? []).length > 0 ? "attached" : null,
        ingresses: new Map(),
        files: new Map(),
      };
      macs.set(instanceId, mac);
      return { metadata: metadata(instanceId, mac) };
    },
    waitInstanceSync: async ({ instanceId }) => ({
      metadata: metadata(instanceId ?? "", find(instanceId)),
    }),
    describeInstance: async ({ instanceId }) => ({
      metadata: metadata(instanceId ?? "", find(instanceId)),
    }),
    destroyInstance: async ({ instanceId }) => {
      const mac = find(instanceId);
      if (mac.destroyed) throw rpcError(9, "instance already destroyed");
      mac.destroyed = true;
      // A halted Mac's cache version is abandoned; a running one commits on destroy.
      if (mac.volume === "attached") mac.volume = mac.halted ? "abandoned" : "committed";
      return {};
    },
    listIngresses: async ({ instanceId }) => ({
      allocatedIngresses: [...find(instanceId).ingresses].map(([name]) => ({
        name,
        fqdn: `${name}-${instanceId}.ord4.nscluster.cloud`,
      })),
    }),
    createIngress: async ({ instanceId, ingresses }) => {
      const mac = find(instanceId);
      for (const ingress of ingresses ?? []) {
        if (mac.ingresses.has(ingress.name ?? "")) throw rpcError(6, "ingress already exists");
        mac.ingresses.set(ingress.name ?? "", ingress.exportedPortBackend?.port ?? 0);
      }
      return {
        allocatedIngresses: [...mac.ingresses].map(([name]) => ({
          name,
          fqdn: `${name}-${instanceId}.ord4.nscluster.cloud`,
        })),
      };
    },
    listInstances: async ({ labelFilter, paginationCursor }) => {
      const found = [...macs].filter(([, mac]) => matches(mac.labels, labelFilter ?? []));
      const page = pageOf(found, paginationCursor);
      return {
        instances: page.items.map(([instanceId, mac]) => metadata(instanceId, mac)),
        paginationCursor: page.paginationCursor,
      };
    },
  };
  const remoteShell = spawnNsc({ binary: "/bin/sh" });
  const nsc: NscCli = {
    run: async (args, options) => {
      nscCalls.push({ args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) });
      if (args[0] === "instance" && args[1] === "upload") {
        const mac = macs.get(args[2] ?? "");
        if (!mac || mac.destroyed) return { exitCode: 1, stdout: "", stderr: "no such instance" };
        mac.files.set(args[4] ?? "", args[3] ?? "");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const [verb, flag, instanceId, separator, command, ...rest] = args;
      if (verb !== "ssh" || flag !== "-T" || separator !== "--" || !command || rest.length > 0)
        throw new Error(`unexpected nsc call: ${args.join(" ")}`);
      const mac = macs.get(instanceId ?? "");
      if (!mac || mac.destroyed || mac.halted)
        return { exitCode: 255, stdout: "", stderr: "ssh: connect: Connection refused" };
      if (command === "'sudo' '-n' 'shutdown' '-h' 'now'") {
        mac.halted = true;
        return { exitCode: 255, stdout: "", stderr: "Connection closed by remote host" };
      }
      return remoteShell.run(["-c", command], options);
    },
  };
  return { macs, createRequests, nscCalls, instances: makeNamespaceInstances({ compute, nsc }) };
}

const neverExisted = Schema.decodeUnknownSync(InstanceId)("never-existed");
const cacheSpec = {
  labels: { "t3.chat": "chat-1", "t3.repo": "megpt-mono" },
  cache: { tag: "t3-megpt-mono", mountPoint: "/Volumes/t3", sizeGb: 100 },
  deadline: 1_790_018_000_123,
  size: "m",
  purpose: "t3 chat chat-1",
} as const;

describe("makeNamespaceInstances", () => {
  it("creates a Mac with its cache volume, labels, placement and deadline, and reports where it landed", async () => {
    const world = makeMacWorld();

    const incarnation = await world.instances.create(cacheSpec);

    expect(incarnation).toEqual({
      instanceId: "mac-1",
      site: "ord4",
      createdAt: 1_790_000_000_250,
      deadline: 1_790_018_000_123,
    });
    expect(world.createRequests).toEqual([
      {
        shape: {
          os: "macos",
          machineArch: "arm64",
          virtualCpu: 6,
          memoryMegabytes: 14_336,
          selectors: [
            { name: "macos.version", value: "26.x" },
            { name: "macos.purpose", value: "githubrunner" },
            { name: "image.with", value: "xcode-latest" },
          ],
        },
        documentedPurpose: "t3 chat chat-1",
        labels: [
          { name: "t3.chat", value: "chat-1" },
          { name: "t3.repo", value: "megpt-mono" },
        ],
        deadline: { seconds: 1_790_018_000n, nanos: 123_000_000 },
        placement: ["continent:us"],
        volumes: [
          { tag: "t3-megpt-mono", mountPoint: "/Volumes/t3", sizeMb: 102_400n, persistencyKind: 2 },
        ],
      },
    ]);
  });

  it("creates a large Mac without a volume when there is no cache", async () => {
    const world = makeMacWorld();

    await world.instances.create({ ...cacheSpec, cache: null, size: "l" });

    expect(world.createRequests).toMatchObject([
      { shape: { virtualCpu: 12, memoryMegabytes: 28_672 }, volumes: [] },
    ]);
    expect(world.macs.get("mac-1")?.volume).toBe(null);
  });

  it("describes a destroyed or unknown instance as null", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);

    expect(await world.instances.describe(instanceId)).toEqual({
      instanceId: "mac-1",
      site: "ord4",
      createdAt: 1_790_000_000_250,
      deadline: 1_790_018_000_123,
    });
    await world.instances.depart(instanceId, "commit");
    expect(await world.instances.describe(instanceId)).toBe(null);
    expect(await world.instances.describe(neverExisted)).toBe(null);
  });

  it("refuses an instance that reports no deadline", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);
    const mac = world.macs.get(instanceId);
    if (mac) mac.deadline = undefined;

    await expect(world.instances.describe(instanceId)).rejects.toThrow(
      "Namespace instance mac-1 has no deadline",
    );
  });

  it("lists live instances carrying every label, across pages", async () => {
    const world = makeMacWorld();
    const create = (labels: Record<string, string>) =>
      world.instances.create({ ...cacheSpec, labels });
    await create({ "t3.chat": "chat-1", "t3.repo": "megpt-mono" });
    await create({ "t3.chat": "chat-1", "t3.repo": "other" });
    await create({ "t3.chat": "chat-2", "t3.repo": "megpt-mono" });
    const destroyed = await create({ "t3.chat": "chat-1", "t3.repo": "megpt-mono" });
    await world.instances.depart(destroyed.instanceId, "commit");
    await create({ "t3.chat": "chat-1", "t3.repo": "megpt-mono" });

    const listed = await world.instances.list({ "t3.chat": "chat-1", "t3.repo": "megpt-mono" });

    expect(listed.map(({ instanceId }) => instanceId)).toEqual(["mac-1", "mac-5"]);
    await expect(world.instances.list({})).rejects.toThrow("needs at least one label");
  });

  it("abandons a Mac by halting it before the destroy, so its cache is not committed", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);

    await world.instances.depart(instanceId, "abandon");

    expect(world.macs.get(instanceId)).toMatchObject({ destroyed: true, volume: "abandoned" });
  });

  it("commits a Mac's cache with a plain destroy", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);

    await world.instances.depart(instanceId, "commit");

    expect(world.macs.get(instanceId)).toMatchObject({ destroyed: true, volume: "committed" });
    expect(world.nscCalls).toEqual([]);
  });

  it("departs an instance that is already gone", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);
    await world.instances.depart(instanceId, "commit");

    await world.instances.depart(instanceId, "commit");
    await world.instances.depart(instanceId, "abandon");
    await world.instances.depart(neverExisted, "commit");
    await world.instances.depart(neverExisted, "abandon");

    expect(world.macs.get(instanceId)?.volume).toBe("committed");
  });

  it("quotes argv for the remote shell and sends stdin privately", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);

    expect(await world.instances.exec(instanceId, ["printf", "%s", "a b'c $HOME `x`"])).toEqual({
      exitCode: 0,
      stdout: "a b'c $HOME `x`",
      stderr: "",
    });
    expect(await world.instances.exec(instanceId, ["cat"], { stdin: "token-123" })).toEqual({
      exitCode: 0,
      stdout: "token-123",
      stderr: "",
    });
    expect(world.nscCalls.at(-1)).toEqual({
      args: ["ssh", "-T", "mac-1", "--", "'cat'"],
      stdin: "token-123",
    });
  });
});

describe("ingress and upload", () => {
  it("exposes a guest port once and hands back the same origin on every call", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);

    expect(await world.instances.expose(instanceId, 3773)).toBe(
      "https://t3-3773-mac-1.ord4.nscluster.cloud",
    );
    expect(await world.instances.expose(instanceId, 3773)).toBe(
      "https://t3-3773-mac-1.ord4.nscluster.cloud",
    );
    expect([...(world.macs.get("mac-1")?.ingresses ?? [])]).toEqual([["t3-3773", 3773]]);
  });

  it("uploads a manager file onto the Mac and reports a failed copy", async () => {
    const world = makeMacWorld();
    const { instanceId } = await world.instances.create(cacheSpec);

    await world.instances.upload(instanceId, "/tmp/runtime.tar", "/Volumes/t3/runtime.tar");
    expect([...(world.macs.get("mac-1")?.files ?? [])]).toEqual([
      ["/Volumes/t3/runtime.tar", "/tmp/runtime.tar"],
    ]);
    await expect(
      world.instances.upload(neverExisted, "/tmp/runtime.tar", "/Volumes/t3/runtime.tar"),
    ).rejects.toThrow("nsc instance upload failed: no such instance");
  });
});

describe("nscWithToken", () => {
  it("hands each command a private token file and removes it afterwards", async () => {
    const stateDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-nsc-token-"));
    try {
      const nsc = nscWithToken({
        stateDir,
        issueToken: async () => "private-token",
        binary: "/bin/sh",
      });
      const { stdout } = await nsc.run([
        "-c",
        'cat "$NSC_TOKEN_FILE"; ls -l "$NSC_TOKEN_FILE" | cut -c1-10',
      ]);
      expect(stdout).toBe('{"bearer_token":"private-token"}-rw-------\n');
      expect(await NodeFSP.readdir(stateDir)).toEqual([]);
    } finally {
      await NodeFSP.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("spawnNsc", () => {
  it("pipes stdin and reports the exit code and both streams", async () => {
    const shell = spawnNsc({ binary: "/bin/sh" });

    expect(await shell.run(["-c", "cat; echo warn >&2; exit 3"], { stdin: "private" })).toEqual({
      exitCode: 3,
      stdout: "private",
      stderr: "warn\n",
    });
  });

  it("kills a command that outlives its timeout", async () => {
    const shell = spawnNsc({ binary: "/bin/sh" });

    await expect(shell.run(["-c", "sleep 5"], { timeoutMs: 100 })).rejects.toThrow(
      "nsc -c timed out after 100ms",
    );
  });
});

interface FakeArtifact {
  readonly labels: Map<string, string>;
  readonly expiresAt: unknown;
  size: bigint | null;
  expired: boolean;
}

function makeArtifactWorld() {
  const stored = new Map<string, FakeArtifact>();
  const uploads = new Map<string, string>();
  const uploaded = new Map<string, bigint>();
  const createRequests: unknown[] = [];
  const signing = {
    upload: "https://storage.test/upload",
    download: "https://storage.test/download",
  };
  const description = (path: string, artifact: FakeArtifact) => ({
    path,
    namespace: "main",
    size: artifact.size ?? 0n,
    expiresAt: artifact.expiresAt,
    status: artifact.expired ? 2 : 1,
  });
  const artifacts: NamespaceArtifactsClient = {
    createArtifact: async (request) => {
      createRequests.push(request);
      const path = request.path ?? "";
      const uploadId = `upload-${uploads.size + 1}`;
      const labels = new Map<string, string>();
      for (const label of request.labels ?? []) labels.set(label.name ?? "", label.value ?? "");
      stored.set(path, { labels, expiresAt: request.expiresAt, size: null, expired: false });
      uploads.set(uploadId, path);
      return { uploadId, signedUploadUrl: `${signing.upload}/${uploadId}?sig=up` };
    },
    finalizeArtifact: async ({ uploadId }) => {
      const path = uploads.get(uploadId ?? "");
      const bytes = uploaded.get(uploadId ?? "");
      const artifact = stored.get(path ?? "");
      if (path === undefined || bytes === undefined || !artifact)
        throw rpcError(9, "nothing was uploaded");
      artifact.size = bytes;
      return { description: description(path, artifact) };
    },
    resolveArtifact: async ({ path, metadataOnly, includeExpired }) => {
      const artifact = stored.get(path ?? "");
      if (!artifact || artifact.size === null || (artifact.expired && !includeExpired))
        throw rpcError(5, "artifact not found");
      return {
        description: description(path ?? "", artifact),
        signedDownloadUrl: metadataOnly ? "" : `${signing.download}/${path}?sig=down`,
      };
    },
    expireArtifact: async ({ path }) => {
      const artifact = stored.get(path ?? "");
      if (!artifact) throw rpcError(5, "artifact not found");
      if (artifact.expired) throw rpcError(9, "artifact already expired");
      artifact.expired = true;
      return {};
    },
    listArtifacts: async ({ namespaces, labelFilter, skipExpired, paginationCursor }) => {
      const found = [...stored].filter(
        ([, artifact]) =>
          (namespaces ?? []).includes("main") &&
          artifact.size !== null &&
          !(skipExpired && artifact.expired) &&
          matches(artifact.labels, labelFilter ?? []),
      );
      const page = pageOf(found, paginationCursor);
      return {
        artifacts: page.items.map(([path, artifact]) => description(path, artifact)),
        paginationCursor: page.paginationCursor,
      };
    },
  };
  return {
    signing,
    createRequests,
    /** What the guest's PUT to the signed URL leaves behind. */
    put: (uploadId: string, bytes: bigint) => uploaded.set(uploadId, bytes),
    artifacts: makeNamespaceArtifacts({ artifacts }),
  };
}

describe("makeNamespaceArtifacts", () => {
  it("uploads, finalizes, signs, lists and expires snapshots", async () => {
    const world = makeArtifactWorld();
    const save = async (path: string, chat: string, bytes: bigint) => {
      const { uploadId } = await world.artifacts.beginUpload({
        path,
        expiresAt: 1_792_000_000_000,
        labels: { "t3.chat": chat },
      });
      world.put(uploadId, bytes);
      return world.artifacts.finalize(uploadId);
    };

    expect(
      await world.artifacts.beginUpload({
        path: "chats/chat-1/1.tgz",
        expiresAt: 1_792_000_000_000,
        labels: { "t3.chat": "chat-1" },
      }),
    ).toEqual({
      uploadId: "upload-1",
      signedUploadUrl: "https://storage.test/upload/upload-1?sig=up",
    });
    expect(world.createRequests).toEqual([
      {
        namespace: "main",
        path: "chats/chat-1/1.tgz",
        expiresAt: { seconds: 1_792_000_000n, nanos: 0 },
        labels: [{ name: "t3.chat", value: "chat-1" }],
      },
    ]);
    world.put("upload-1", 4096n);
    expect(await world.artifacts.finalize("upload-1")).toEqual({
      path: "chats/chat-1/1.tgz",
      bytes: 4096,
    });
    expect(await save("chats/chat-1/2.tgz", "chat-1", 8192n)).toEqual({
      path: "chats/chat-1/2.tgz",
      bytes: 8192,
    });
    await save("chats/chat-2/1.tgz", "chat-2", 512n);

    expect(await world.artifacts.downloadUrl("chats/chat-1/2.tgz")).toBe(
      "https://storage.test/download/chats/chat-1/2.tgz?sig=down",
    );
    expect(await world.artifacts.list({ "t3.chat": "chat-1" })).toEqual([
      { path: "chats/chat-1/1.tgz", bytes: 4096, expiresAt: 1_792_000_000_000 },
      { path: "chats/chat-1/2.tgz", bytes: 8192, expiresAt: 1_792_000_000_000 },
    ]);

    await world.artifacts.expire("chats/chat-1/1.tgz");
    await world.artifacts.expire("chats/chat-1/1.tgz");
    await world.artifacts.expire("chats/never-saved.tgz");

    expect(await world.artifacts.list({ "t3.chat": "chat-1" })).toEqual([
      { path: "chats/chat-1/2.tgz", bytes: 8192, expiresAt: 1_792_000_000_000 },
    ]);
    expect(
      [
        await world.artifacts.downloadUrl("chats/chat-1/1.tgz"),
        await world.artifacts.downloadUrl("chats/never-saved.tgz"),
      ],
      "an expired or unknown snapshot reads as gone",
    ).toEqual([null, null]);
  });

  it("refuses a signed URL that is not private HTTPS", async () => {
    const world = makeArtifactWorld();
    world.signing.upload = "http://storage.test/upload";
    world.signing.download = "https://user:secret@storage.test/download";

    await expect(
      world.artifacts.beginUpload({ path: "a.tgz", expiresAt: 1_792_000_000_000, labels: {} }),
    ).rejects.toThrow("not private HTTPS");
    world.put("upload-1", 1n);
    await world.artifacts.finalize("upload-1");
    await expect(world.artifacts.downloadUrl("a.tgz")).rejects.toThrow("not private HTTPS");
  });
});
