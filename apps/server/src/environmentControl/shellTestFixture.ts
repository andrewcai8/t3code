import { OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ShellWire = Schema.toCodecJson(OrchestrationV2ShellSnapshot);
const decodeShell = Schema.decodeUnknownSync(ShellWire);
const encodeShell = Schema.encodeSync(ShellWire);

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
  createdBy: "user",
  creationSource: "web",
  id,
  projectId,
  title,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: "2026-09-30T10:02:00.000Z",
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  itemCount: 2,
  visibleItemCount: 2,
  createdAt: "2026-09-30T10:01:00.000Z",
  updatedAt: "2026-09-30T10:05:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
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
          schemaVersion: 1,
          snapshotSequence: 42,
          projects: [project, { ...project, id: "project-other", title: "other" }],
          threads,
          archivedThreads: [],
        }),
      ),
    ),
  ) as Record<string, unknown>;
