// @effect-diagnostics nodeBuiltinImport:off - bundles are refreshed at the same Promise-based boundary provisioning reads them from.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function fetchArchive(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!response.ok) throw new Error(`Skill bundle download failed with HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

async function holdsSkill(tree: string) {
  for (const entry of await NodeFSP.readdir(tree, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = await NodeFSP.stat(NodePath.join(tree, entry.name, "SKILL.md")).catch(
      () => undefined,
    );
    if (skill?.isFile()) return true;
  }
  return false;
}

async function extract(archive: Uint8Array, versions: string, target: string) {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(versions, ".partial-"));
  try {
    const file = NodePath.join(scratch, "bundle.tar.gz");
    const tree = NodePath.join(scratch, "bundle");
    await NodeFSP.writeFile(file, archive);
    await NodeFSP.mkdir(tree);
    // `-m` gives the extracted root a fresh mtime even when the archive carries
    // its own `./` entry: the skill listing notices a new version by that mtime.
    await execFile("tar", ["-x", "-z", "-m", "--no-same-owner", "-f", file, "-C", tree]);
    if (!(await holdsSkill(tree)))
      throw new Error("Skill bundle archive holds no <skill>/SKILL.md at its root.");
    await NodeFSP.rename(tree, target);
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Points `source` at the extracted contents of the archive published at `url`.
 *
 * `source` is a link to `${source}.versions/<sha256 of the archive>`, replaced
 * by a rename, so a provision that resolved it keeps reading one whole
 * version. That version and the new one survive the prune. Every step
 * converges when rerun, so the next refresh finishes one interrupted anywhere.
 */
export async function refreshSkillBundle(
  bundle: { readonly source: string; readonly url: string },
  download: (url: string) => Promise<Uint8Array> = fetchArchive,
): Promise<"unchanged" | "updated"> {
  const source = NodePath.resolve(bundle.source);
  const versions = `${source}.versions`;
  const existing = await NodeFSP.lstat(source).catch(() => undefined);
  if (existing && !existing.isSymbolicLink())
    throw new Error(
      `Skill bundle source ${source} is not a link the manager owns. Point a bundle with a url at a fresh path.`,
    );
  const previous =
    existing && NodePath.resolve(NodePath.dirname(source), await NodeFSP.readlink(source));

  const archive = await download(bundle.url);
  const hash = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const target = NodePath.join(versions, hash);
  if (previous !== target) {
    await NodeFSP.mkdir(versions, { recursive: true });
    const extracted = await NodeFSP.stat(target).then(
      () => true,
      () => false,
    );
    if (!extracted) await extract(archive, versions, target);
    const link = `${source}.next`;
    await NodeFSP.rm(link, { force: true });
    await NodeFSP.symlink(NodePath.relative(NodePath.dirname(source), target), link);
    await NodeFSP.rename(link, source);
  }

  const keep = new Set([hash, previous && NodePath.basename(previous)]);
  for (const entry of await NodeFSP.readdir(versions))
    if (!keep.has(entry))
      await NodeFSP.rm(NodePath.join(versions, entry), { recursive: true, force: true });
  return previous === target ? "unchanged" : "updated";
}
