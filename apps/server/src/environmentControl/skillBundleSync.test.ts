// @effect-diagnostics nodeBuiltinImport:off - this test builds real tarballs and skill bundles in a temporary directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, assert, beforeEach, it } from "@effect/vitest";

import { readProvisionedSkills } from "./provisionedSkills.ts";
import { refreshSkillBundle } from "./skillBundleSync.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

let directory: string;
let source: string;
beforeEach(async () => {
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "skill-bundle-sync-"));
  source = NodePath.join(directory, "host", "skills");
  await NodeFSP.mkdir(NodePath.dirname(source));
});
afterEach(() => NodeFSP.rm(directory, { recursive: true, force: true }));

let archives = 0;
const archiveOf = async (skills: ReadonlyArray<string>, extraFiles: ReadonlyArray<string> = []) => {
  const staging = NodePath.join(directory, "fixtures", `staging-${archives}`);
  const file = NodePath.join(directory, "fixtures", `archive-${archives++}.tar.gz`);
  await NodeFSP.mkdir(staging, { recursive: true });
  for (const skill of skills) {
    await NodeFSP.mkdir(NodePath.join(staging, skill));
    await NodeFSP.writeFile(
      NodePath.join(staging, skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${skill}.\n---\n`,
    );
  }
  for (const extra of extraFiles) await NodeFSP.writeFile(NodePath.join(staging, extra), "x");
  await execFile("tar", ["-czf", file, "-C", staging, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return new Uint8Array(await NodeFSP.readFile(file));
};

const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const serving = (archive: Uint8Array) => async () => archive;
const refresh = (archive: Uint8Array) =>
  refreshSkillBundle({ source, url: "https://skills.invalid/bundle.tar.gz" }, serving(archive));
const listed = async () =>
  (await readProvisionedSkills([{ source, agents: ["claudeAgent"] }])).claudeAgent?.map(
    (skill) => skill.name,
  );
const versions = async () => (await NodeFSP.readdir(`${source}.versions`)).toSorted();

it("follows each newly published archive and keeps only the current and previous versions", async () => {
  const first = await archiveOf(["how", "why"]);
  assert.strictEqual(await refresh(first), "updated");
  assert.strictEqual(await NodeFSP.readlink(source), `skills.versions/${sha256(first)}`);
  assert.deepEqual(await listed(), ["how", "why"]);

  assert.strictEqual(await refresh(first), "unchanged");
  assert.deepEqual(await versions(), [sha256(first)]);

  const second = await archiveOf(["how", "poteto-mode"]);
  assert.strictEqual(await refresh(second), "updated");
  assert.deepEqual(await listed(), ["how", "poteto-mode"]);
  assert.deepEqual(await versions(), [sha256(first), sha256(second)].toSorted());

  const third = await archiveOf(["teach"]);
  assert.strictEqual(await refresh(third), "updated");
  assert.deepEqual(await listed(), ["teach"]);
  assert.deepEqual(await versions(), [sha256(second), sha256(third)].toSorted());
});

it("refuses an archive with no skills and keeps serving the previous one", async () => {
  await refresh(await archiveOf(["how"]));
  const empty = await archiveOf([], ["README.md"]);
  const refused = await refresh(empty).then(
    () => "updated",
    (error: Error) => error.message,
  );
  assert.strictEqual(refused, "Skill bundle archive holds no <skill>/SKILL.md at its root.");
  assert.deepEqual(await listed(), ["how"]);
});

it("refuses a source directory it does not own and leaves it untouched", async () => {
  await NodeFSP.mkdir(NodePath.join(source, "hand-published"), { recursive: true });
  const refused = await refresh(await archiveOf(["how"])).then(
    () => "updated",
    (error: Error) => error.message,
  );
  assert.strictEqual(
    refused,
    `Skill bundle source ${source} is not a link the manager owns. Point a bundle with a url at a fresh path.`,
  );
  assert.deepEqual(await NodeFSP.readdir(source), ["hand-published"]);
  assert.deepEqual(await NodeFSP.readdir(NodePath.dirname(source)), ["skills"]);
});

it("keeps serving the previous version when the download fails", async () => {
  const first = await archiveOf(["how"]);
  await refresh(first);
  const failed = await refreshSkillBundle(
    { source, url: "https://skills.invalid/bundle.tar.gz" },
    async () => {
      throw new Error("HTTP 503");
    },
  ).then(
    () => "updated",
    (error: Error) => error.message,
  );
  assert.strictEqual(failed, "HTTP 503");
  assert.strictEqual(await NodeFSP.readlink(source), `skills.versions/${sha256(first)}`);
  assert.deepEqual(await listed(), ["how"]);
});

it("finishes a refresh that crashed before swapping the link", async () => {
  const first = await archiveOf(["how"]);
  await refresh(first);
  await NodeFSP.mkdir(`${source}.versions/.partial-crashed/bundle`, { recursive: true });
  await NodeFSP.symlink("skills.versions/.partial-crashed/bundle", `${source}.next`);

  const second = await archiveOf(["why"]);
  assert.strictEqual(await refresh(second), "updated");
  assert.deepEqual(await listed(), ["why"]);
  assert.deepEqual(await versions(), [sha256(first), sha256(second)].toSorted());
  assert.deepEqual((await NodeFSP.readdir(NodePath.dirname(source))).toSorted(), [
    "skills",
    "skills.versions",
  ]);
});
