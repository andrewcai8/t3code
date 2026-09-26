#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a packer and CLI for deploy scripts, outside Effect.
/**
 * Computes the state a provisioning host needs on disk: its
 * `environment-control` config, a slim `settings.json`, each travelling
 * account's credential files, shell-environment copies, and skill bundles.
 * Transports decide where it lands: `deploy-provision-manager.mjs` writes it
 * into an E2B sandbox, and the CLI below packs it as a seed tarball for a
 * container host.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { credentialDestinations } from "../../apps/server/src/environmentControl/credentialDestinations.ts";
import { planManagerAccounts, type PlanInput } from "./provision-manager-accounts.ts";

interface ConfiguredFile {
  readonly source: string;
  readonly destination: string;
}

/** The host's `environment-control.json`, as written. */
export interface HostConfig {
  readonly e2bApiKey?: string;
  readonly namespaceToken?: string;
  readonly provisioning?: PlanInput["provisioning"] & {
    readonly templateId?: string;
    readonly runtimeArtifacts?: unknown;
    readonly githubToken?: string;
    readonly namespace?: unknown;
    readonly repositories?: ReadonlyArray<{
      readonly repository: string;
      readonly workspaceFiles?: unknown;
      readonly e2b?: unknown;
      readonly namespace?: unknown;
    }>;
    readonly egressAllow?: unknown;
    readonly homeFiles?: ReadonlyArray<ConfiguredFile>;
    readonly workspaceFiles?: ReadonlyArray<ConfiguredFile>;
    readonly skills?: ReadonlyArray<{
      readonly source: string;
      readonly name?: string;
      readonly agents?: ReadonlyArray<string>;
    }>;
  };
}

export interface Broker {
  readonly sandboxId: string;
  readonly metadata: Record<string, string>;
  readonly url: string;
  readonly ingressKey: string;
}

export interface PackInput {
  readonly config: HostConfig;
  readonly settings: PlanInput["settings"];
  readonly accounts?: ReadonlyArray<string> | undefined;
  readonly host: PlanInput["host"];
  /** The host's `--base-dir`. */
  readonly baseDir: string;
  /** Skill bundle `i` unpacks into `<skillsDir>/<i>`. */
  readonly skillsDir: string;
  /**
   * A Namespace login's `token.json`. Its session token lands at
   * `<baseDir>/ns/token.json`, where the Namespace SDK finds it on a host run
   * with `XDG_CONFIG_HOME=<baseDir>`.
   */
  readonly namespaceSession?: string | undefined;
  /**
   * The host keeps and refreshes its own federated Namespace token wherever
   * the server's Namespace SDK resolves it (`$XDG_CONFIG_HOME/ns/token.json`,
   * or `~/.config/ns/token.json` on Linux), so the settings travel with no
   * packed credential.
   */
  readonly namespaceFederated?: boolean | undefined;
}

export interface HostState {
  readonly accounts: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ readonly id: string; readonly reason: string }>;
  /**
   * The host's config minus what only the transport knows: `broker`, which for
   * the E2B manager is the sandbox it creates after packing, and
   * `provisioning.runtimeArtifacts`, which a host pins itself. Namespace
   * settings travel only with a `namespaceToken` or a Namespace session: a host
   * has no `nsc login` of its own, so without one it could not start the Macs
   * it offers.
   */
  readonly config: {
    readonly e2bApiKey: string;
    readonly namespaceToken?: string;
    readonly targets: readonly [];
    readonly provisioning: Record<string, unknown> & { readonly templateId: string };
  };
  /** Every file is private to the host user (0600). */
  readonly files: ReadonlyArray<{ readonly path: string; readonly data: string | Buffer }>;
  /** Gzipped tarballs, each unpacked into its directory. */
  readonly skills: ReadonlyArray<{ readonly directory: string; readonly archive: Buffer }>;
}

// COPYFILE_DISABLE is what actually suppresses AppleDouble sidecars on macOS.
// `tar --no-xattrs` alone does not, and the sidecars are invisible locally, so
// a bundle only looks wrong once it is on the host.
const tar = (args: ReadonlyArray<string>, input?: Buffer) => {
  const result = NodeChildProcess.spawnSync("tar", args, {
    input,
    maxBuffer: 1 << 30,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (result.status !== 0) throw new Error(`tar ${args.join(" ")} failed`);
  return result.stdout;
};

/** Reads every credential up front, so a missing file fails before any host is touched. */
export async function packHostState(input: PackInput): Promise<HostState> {
  const { config } = input;
  const e2bApiKey = config.e2bApiKey;
  if (typeof e2bApiKey !== "string" || !e2bApiKey) throw new Error("E2B API key is missing");
  const templateId = config.provisioning?.templateId;
  if (!templateId) throw new Error("Configure provisioning.templateId before deploying a host");

  const plan = planManagerAccounts({
    settings: input.settings,
    provisioning: config.provisioning ?? {},
    accounts: input.accounts,
    host: input.host,
    managerBaseDir: input.baseDir,
  });
  if (plan.accounts.length === 0) throw new Error("No provider account can travel");

  const files: Array<{ path: string; data: string | Buffer }> = [
    {
      path: plan.settingsPath,
      // Hosts run the provider CLIs baked into their image or template as
      // another user, so an in-app update can't install and wouldn't survive.
      data: JSON.stringify({
        enableProviderUpdateChecks: false,
        providerInstances: plan.providerInstances,
      }),
    },
  ];
  for (const file of plan.files)
    files.push({ path: file.destination, data: await NodeFSP.readFile(file.source) });
  if (input.namespaceSession) {
    // Errors name the file and never its contents, since a JSON.parse message quotes the input.
    let sessionToken: unknown;
    try {
      sessionToken = JSON.parse(
        await NodeFSP.readFile(input.namespaceSession, "utf8"),
      )?.session_token;
    } catch {
      throw new Error(`${input.namespaceSession} is not a Namespace token.json`);
    }
    if (typeof sessionToken !== "string" || !sessionToken)
      throw new Error(`${input.namespaceSession} has no session_token; run \`nsc login\``);
    files.push({
      path: NodePath.posix.join(input.baseDir, "ns/token.json"),
      data: JSON.stringify({ session_token: sessionToken }),
    });
  }

  // Configured files name paths on this machine, so each travels as a copy the
  // host owns and the entry is re-pointed at it, like `shellEnvironment`. A
  // login file stays behind: the host installs each account's own, and a
  // copied one would replace it.
  const credentialFiles = new Set<string>(Object.values(credentialDestinations).flat());
  // Provisioning writes these for `githubToken` (ProvisionPreparation), and a
  // guest refuses a second, different file at the same path.
  const githubFiles = new Set(
    config.provisioning?.githubToken
      ? [".gitconfig", ".git-credentials", ".config/gh/hosts.yml"]
      : [],
  );
  const skippedFiles: Array<{ id: string; reason: string }> = [];
  const carry = async (key: "homeFiles" | "workspaceFiles", directory: string) => {
    const carried: Array<ConfiguredFile> = [];
    for (const [index, entry] of (config.provisioning?.[key] ?? []).entries()) {
      const destination = NodePath.posix.normalize(entry.destination);
      if (key === "homeFiles" && credentialFiles.has(destination)) {
        skippedFiles.push({
          id: `homeFiles ${entry.destination}`,
          reason: "the host installs each account's own login",
        });
        continue;
      }
      if (key === "homeFiles" && githubFiles.has(destination))
        throw new Error(
          `homeFiles ${entry.destination} clashes with the file provisioning writes for githubToken`,
        );
      const data = await NodeFSP.readFile(entry.source).catch((error: NodeJS.ErrnoException) => {
        throw new Error(`${key} source ${entry.source} could not be read (${error.code})`);
      });
      const source = NodePath.posix.join(input.baseDir, directory, String(index));
      files.push({ path: source, data });
      carried.push({ source, destination: entry.destination });
    }
    return carried;
  };
  const homeFiles = await carry("homeFiles", "home-files");
  const workspaceFiles = await carry("workspaceFiles", "workspace-files");

  const bundles = (config.provisioning?.skills ?? []).map((skill, index) => {
    const directory = NodePath.posix.join(input.skillsDir, String(index));
    const name = NodePath.basename(skill.source);
    return {
      directory,
      archive: tar(["--no-xattrs", "-czf", "-", "-C", NodePath.dirname(skill.source), name]),
      source: {
        source: NodePath.posix.join(directory, name),
        ...(skill.name ? { name: skill.name } : {}),
        ...(skill.agents ? { agents: skill.agents } : {}),
      },
    };
  });

  const provisioning = config.provisioning;
  const namespaceToken = config.namespaceToken;
  if (input.namespaceFederated && (namespaceToken || input.namespaceSession))
    throw new Error(
      "--namespace-federated reads the host's own token file; drop namespaceToken and --namespace-session",
    );
  const namespaceAuthorized = Boolean(
    namespaceToken || input.namespaceSession || input.namespaceFederated,
  );
  // A repository entry's `workspaceFiles` name paths on this machine, so only
  // its Namespace settings travel. Their artifact paths live in Namespace's
  // storage, not on disk.
  const namespaceRepositories = namespaceAuthorized
    ? (provisioning?.repositories ?? []).flatMap(({ repository, namespace }) =>
        namespace ? [{ repository, namespace }] : [],
      )
    : [];
  return {
    accounts: plan.accounts,
    skipped: [...plan.skipped, ...skippedFiles],
    files,
    skills: bundles.map(({ directory, archive }) => ({ directory, archive })),
    config: {
      e2bApiKey,
      ...(namespaceToken ? { namespaceToken } : {}),
      targets: [],
      provisioning: {
        templateId,
        ...(provisioning?.githubToken ? { githubToken: provisioning.githubToken } : {}),
        // Carry the host's provisioning policy through. Dropping egressAllow left
        // provisioned environments without the allowlist their preparation needs,
        // which fails far from here as an unreachable package host.
        ...(provisioning?.egressAllow ? { egressAllow: provisioning.egressAllow } : {}),
        // The host's `shellEnvironment` names source paths on the host, and
        // freezing a manifest reads every one of them, so the entries the manager
        // gets point at copies it owns. Carrying the host's paths verbatim made
        // every provision fail with an ENOENT naming another machine.
        ...(plan.shellEnvironment ? { shellEnvironment: plan.shellEnvironment } : {}),
        ...(homeFiles.length ? { homeFiles } : {}),
        ...(workspaceFiles.length ? { workspaceFiles } : {}),
        skills: bundles.map((bundle) => bundle.source),
        ...(namespaceAuthorized && provisioning?.namespace
          ? { namespace: provisioning.namespace }
          : {}),
        ...(namespaceRepositories.length ? { repositories: namespaceRepositories } : {}),
      },
    },
  };
}

/**
 * Writes `state` as a gzipped tarball whose root is `baseDir`. The config is
 * `environment-control.base.json`: the host adds `provisioning.runtimeArtifacts`
 * at boot, because it pins its own artifacts.
 */
export async function writeSeedArchive(input: {
  readonly state: HostState;
  readonly broker: Broker;
  readonly baseDir: string;
  readonly output: string;
}) {
  const stage = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-host-seed-"));
  const staged = (path: string) => {
    const relative = NodePath.posix.relative(input.baseDir, path);
    if (!relative || relative.startsWith("..") || NodePath.posix.isAbsolute(relative))
      throw new Error(`${path} is outside the base dir ${input.baseDir}`);
    return NodePath.join(stage, relative);
  };
  try {
    const files = [
      {
        path: NodePath.posix.join(input.baseDir, "environment-control.base.json"),
        data: JSON.stringify({ ...input.state.config, broker: input.broker }),
      },
      ...input.state.files,
    ];
    for (const file of files) {
      const destination = staged(file.path);
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(destination, file.data, { mode: 0o600 });
    }
    for (const skill of input.state.skills) {
      const directory = staged(skill.directory);
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      tar(["-xzf", "-", "-C", directory], skill.archive);
    }
    tar([
      "--no-xattrs",
      "-czf",
      NodePath.resolve(input.output),
      "-C",
      stage,
      ...(await NodeFSP.readdir(stage)).toSorted(),
    ]);
  } finally {
    await NodeFSP.rm(stage, { recursive: true, force: true });
  }
}

const USAGE = `Usage: node scripts/cloud/pack-host-state.ts --output FILE.tgz --base-dir DIR
       --broker-url https://HOST [--config FILE] [--settings FILE] [--accounts ID,ID,...]
       [--namespace-session FILE | --namespace-federated]

Packs a provisioning host's state as a seed tarball rooted at --base-dir, for
a container that runs the linux runtime artifact baked into its image. The
tarball holds credentials; treat it as a secret.
Namespace (macOS) settings are carried only with a namespaceToken in the
config or a --namespace-session, the token.json of an \`nsc login\` (on macOS,
~/Library/Application Support/ns/token.json). Its session token lands at
<base-dir>/ns/token.json, so run the host with XDG_CONFIG_HOME=<base-dir>, and
re-pack after each monthly login. --namespace-federated carries the settings
with no credential, for a host that keeps a federated workload token wherever
the server's Namespace SDK resolves it ($XDG_CONFIG_HOME/ns/token.json, or
~/.config/ns/token.json on Linux) and refreshes it there. The workspace is whichever tenant the credential names;
Namespace settings do not choose one. Runtime artifacts are never carried; the
host adds its own.`;

if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      output: { type: "string" },
      "base-dir": { type: "string" },
      "broker-url": { type: "string" },
      config: {
        type: "string",
        default: NodePath.join(NodeOS.homedir(), ".t3/environment-control.json"),
      },
      settings: {
        type: "string",
        default: NodePath.join(NodeOS.homedir(), ".t3/userdata/settings.json"),
      },
      accounts: { type: "string" },
      "namespace-session": { type: "string" },
      "namespace-federated": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const baseDir = values["base-dir"];
  const brokerUrl = values["broker-url"];
  if (!values.output || !baseDir || !brokerUrl) throw new Error(USAGE);
  if (!NodePath.posix.isAbsolute(baseDir)) throw new Error("--base-dir must be an absolute path");
  if (new URL(brokerUrl).protocol !== "https:") throw new Error("--broker-url must be https");

  const state = await packHostState({
    config: JSON.parse(await NodeFSP.readFile(values.config, "utf8")),
    settings: JSON.parse(await NodeFSP.readFile(values.settings, "utf8")),
    accounts: values.accounts
      ?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Deploy script has no Effect runtime.
    host: { homedir: NodeOS.homedir(), platform: process.platform, environment: process.env },
    baseDir,
    skillsDir: NodePath.posix.join(baseDir, "skills"),
    namespaceSession: values["namespace-session"],
    namespaceFederated: values["namespace-federated"],
  });
  for (const { id, reason } of state.skipped) console.log(`skipping ${id}: ${reason}`);
  console.log(`carrying accounts ${state.accounts.join(", ")}`);
  await writeSeedArchive({
    state,
    baseDir,
    output: values.output,
    // With no `targets`, nothing reads the broker: every use sits behind a
    // managed target (see EnvironmentControl's `command`). The schema still
    // requires the block, so it names no sandbox rather than inventing one.
    broker: {
      sandboxId: "none",
      metadata: { purpose: "t3-environment", account: "aws-host" },
      url: brokerUrl,
      ingressKey: `ingress-${NodeCrypto.randomUUID()}`,
    },
  });
  console.log(`wrote ${NodePath.resolve(values.output)}`);
}
