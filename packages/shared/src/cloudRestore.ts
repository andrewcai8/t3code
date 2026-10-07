/**
 * Planning how a cloud chat comes back on a fresh machine from its backup, shared by the host's
 * automatic rebuild and the operator's `move-chat restore`.
 *
 * @module cloudRestore
 */
import type { CloudBackupManifest } from "@t3tools/contracts";

/** `owner/name` of a GitHub remote URL, or null for any other host. */
export function githubRepository(remoteUrl: string): string | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export interface CloudRestorePlan {
  readonly repository: string;
  /** The branch the fresh box is provisioned on. */
  readonly branch: string;
  /** The bundle key to fetch `refs/t3-bundle/*` from, when the work was kept out of origin. */
  readonly bundle: string | null;
  /** The branch the chat carries on from: fetched from the bundle or origin, then switched to. */
  readonly checkout: string;
  readonly sessionId: string;
  /** The session's transcript, as a key under the backup's prefix. */
  readonly transcript: string;
  readonly title: string;
  /** The first message on the new box, telling the agent what came back and what did not. */
  readonly message: string;
}

/**
 * How a chat comes back on a fresh box from the last backup of its old box: on the backup branch
 * of its main checkout when the old box had unsaved work there, otherwise on the branch it had
 * checked out, with its latest Claude session. `why` tells the agent why it moved. Throws when the
 * backup cannot make the chat whole: no GitHub repository, no branch, or no Claude session.
 */
export function planCloudRestore(
  manifest: CloudBackupManifest,
  uri: string,
  why: string,
): CloudRestorePlan {
  const repository = manifest.repository && githubRepository(manifest.repository);
  if (!repository)
    throw new Error(`the backup names no GitHub repository (${manifest.repository})`);
  const mainBackup = `t3-backup/${manifest.leaseId}`;
  const saved = manifest.backupBranches.includes(mainBackup);
  // Bundled work is fetched onto a box provisioned on a branch origin has.
  const branch = manifest.bundle
    ? manifest.branchOnOrigin
      ? manifest.branch
      : manifest.defaultBranch
    : saved
      ? mainBackup
      : manifest.branch;
  if (!branch) throw new Error("the backup names no branch origin has to start the box on");
  const checkout = saved ? mainBackup : branch;
  const restorable = manifest.sessions
    .filter((candidate) => candidate.driver === "claudeAgent")
    .flatMap((candidate) => {
      const transcript = candidate.files.find((file) =>
        file.endsWith(`/${candidate.nativeId}.jsonl`),
      );
      return transcript ? [{ sessionId: candidate.nativeId, transcript }] : [];
    })
    .at(-1);
  if (!restorable) {
    const others = manifest.sessions.map((candidate) => candidate.driver).join(", ");
    throw new Error(
      `the backup holds no Claude session to restore${others ? ` (only ${others}, under ${uri})` : ""}`,
    );
  }
  const otherBranches = manifest.backupBranches.filter((name) => name !== checkout);
  const title = manifest.title ?? `Restored ${manifest.environmentId}`;
  return {
    repository,
    branch,
    bundle: manifest.bundle,
    checkout,
    ...restorable,
    title,
    message: [
      `This chat was restored on a fresh machine from the backup of its old machine (environment ${manifest.environmentId}): ${why}`,
      checkout === mainBackup
        ? `The checkout is ${checkout}: the old machine's ${manifest.branch ?? "checkout"} with its unpushed commits, plus any uncommitted changes as one commit titled "T3 backup of unsaved work". Move that work back onto your own branch before you push.`
        : `The checkout is ${checkout}; the old machine had no unpushed work in it.`,
      ...(otherBranches.length > 0
        ? [
            `Other unsaved work is on: ${otherBranches.join(", ")}${manifest.bundle ? " (local branches, never pushed: the repository may be public)" : ""}.`,
          ]
        : []),
      "Files outside the checkout, running processes and anything else on the old machine did not come back. Check `git status` and `git log -3`, then carry on where you left off.",
    ].join("\n\n"),
  };
}
