import { OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeShell = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
const encodeShell = Schema.encodeSync(OrchestrationShellSnapshot);

const project = {
  id: "project-app",
  title: "app",
  workspaceRoot: "/home/user/work/app",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-30T10:00:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z",
};

/** A chat thread as a box's shell holds it, with `fields` laid over an idle one. */
export const boxThread = (
  id: string,
  projectId: string,
  title: string,
  fields: Record<string, unknown> = {},
) => ({
  id,
  projectId,
  title,
  modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-30T10:01:00.000Z",
  updatedAt: "2026-09-30T10:05:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: "2026-09-30T10:02:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...fields,
});

/**
 * A box's shell exactly as its `/api/orchestration/shell` route sends it, at sequence 42, with
 * projects `project-app` and `project-other`.
 */
export const boxShell = (threads: ReadonlyArray<Record<string, unknown>>) =>
  JSON.parse(
    JSON.stringify(
      encodeShell(
        decodeShell({
          snapshotSequence: 42,
          projects: [project, { ...project, id: "project-other", title: "other" }],
          threads,
          updatedAt: "2026-09-30T10:05:00.000Z",
        }),
      ),
    ),
  ) as Record<string, unknown>;
