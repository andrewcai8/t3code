import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  ProvisionedChat,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ProvisionedBox } from "../cloud/provisioning.ts";
import { type ConnectionCatalogEntry, isUnpairedBox } from "./catalog.ts";
import { type BoxAttachment, BearerConnectionTarget, connectionBox } from "./model.ts";

/** One change that brings this device's boxes of a host in line with the host's list. */
export type HostBoxSyncStep =
  /** Save a chat box this device has never seen, unpaired, seeding its cache with the chat. */
  | {
      readonly _tag: "Adopt";
      readonly target: BearerConnectionTarget;
      readonly chat: ProvisionedChat | null;
    }
  /** Follow the host's name for a saved box, keeping its connection. */
  | { readonly _tag: "Relabel"; readonly environmentId: EnvironmentId; readonly label: string }
  /** Replace a box's cached chat with the host's newer read of it. */
  | {
      readonly _tag: "Reseed";
      readonly environmentId: EnvironmentId;
      readonly chat: ProvisionedChat;
    }
  /** A connection saved before boxes were marked, which the host names as its box. */
  | {
      readonly _tag: "MarkBox";
      readonly environmentId: EnvironmentId;
      readonly box: BoxAttachment;
      readonly label: string;
    }
  /** Stop dialing a box the host lost, keeping its history readable. */
  | { readonly _tag: "MarkMissing"; readonly environmentId: EnvironmentId }
  /**
   * Drop an unpaired box that is gone, with its seeded cache. `disposed` when the host listed it
   * disposed, false when the host no longer lists it.
   */
  | { readonly _tag: "Forget"; readonly environmentId: EnvironmentId; readonly disposed: boolean };

export interface HostBoxSyncInput {
  readonly managerId: EnvironmentId;
  readonly entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;
  /** Everything the host lists, as it answered. */
  readonly boxes: ReadonlyArray<ProvisionedBox>;
  /** The snapshot sequence of each listed box's cached chat; absent when none is cached. */
  readonly cachedSequences: ReadonlyMap<EnvironmentId, number>;
  /** Boxes connected now, whose own stream outranks any copy of their chat. */
  readonly connected: ReadonlySet<EnvironmentId>;
}

/**
 * Plans how this device's boxes of `managerId` follow the host's list, the source of truth for
 * which cloud chats exist. Applying the plan never dials, pairs or wakes a box, and planning
 * against its result plans nothing.
 */
export function planHostBoxSync(input: HostBoxSyncInput): ReadonlyArray<HostBoxSyncStep> {
  const { managerId, entries } = input;
  const managers = new Set<EnvironmentId>([managerId]);
  for (const entry of entries.values()) {
    const box = connectionBox(entry.target);
    if (box !== null) managers.add(box.managerId);
  }
  const steps: Array<HostBoxSyncStep> = [];
  const listed = new Set<EnvironmentId>();
  for (const row of input.boxes) {
    if (row.managerId !== managerId || managers.has(row.environmentId)) continue;
    listed.add(row.environmentId);
    const gone = row.lifecycle === "missing" || row.lifecycle === "disposed";
    const entry = entries.get(row.environmentId);
    if (entry === undefined) {
      if (!gone && row.threadId !== null)
        steps.push({
          _tag: "Adopt",
          target: new BearerConnectionTarget({
            environmentId: row.environmentId,
            label: row.label,
            connectionId: `bearer:${row.environmentId}`,
            box: { managerId },
          }),
          chat: row.chat,
        });
      continue;
    }
    const target = entry.target;
    if (target._tag !== "BearerConnectionTarget") continue;
    if (target.box === undefined) {
      steps.push({
        _tag: "MarkBox",
        environmentId: row.environmentId,
        box: { managerId },
        label: row.label,
      });
    } else if (target.box.managerId !== managerId) {
      continue;
    } else if (row.lifecycle === "disposed" && isUnpairedBox(entry)) {
      steps.push({ _tag: "Forget", environmentId: row.environmentId, disposed: true });
      continue;
    } else if (target.label !== row.label) {
      steps.push({ _tag: "Relabel", environmentId: row.environmentId, label: row.label });
    }
    if (
      !gone &&
      row.chat !== null &&
      row.chat.sequence > (input.cachedSequences.get(row.environmentId) ?? -1) &&
      !input.connected.has(row.environmentId)
    )
      steps.push({ _tag: "Reseed", environmentId: row.environmentId, chat: row.chat });
    if (gone && target.workspaceStatus !== "missing")
      steps.push({ _tag: "MarkMissing", environmentId: row.environmentId });
  }
  for (const [environmentId, entry] of entries) {
    if (
      !listed.has(environmentId) &&
      isUnpairedBox(entry) &&
      connectionBox(entry.target)?.managerId === managerId
    )
      steps.push({ _tag: "Forget", environmentId, disposed: false });
  }
  return steps;
}

/** The chat a box's host last listed for it, as this runtime received it. */
export interface HostChat {
  readonly managerId: EnvironmentId;
  readonly chat: ProvisionedChat;
}

/** A box's shell as its host last read it: the box's chat and that chat's project. */
export function chatShellSnapshot(chat: ProvisionedChat): OrchestrationV2ShellSnapshot {
  return {
    schemaVersion: 1,
    snapshotSequence: chat.sequence,
    projects: [chat.project],
    threads: chat.thread.archivedAt === null ? [chat.thread] : [],
    archivedThreads: [],
  };
}

/**
 * A box's shell with its host's newer read of the chat merged in: the chat's thread and project
 * replace their copies and the box's other threads stay. Null when the shell already holds this
 * chat or a newer one.
 */
export function withHostChat(
  shell: Option.Option<OrchestrationV2ShellSnapshot>,
  chat: ProvisionedChat,
): OrchestrationV2ShellSnapshot | null {
  if (Option.isNone(shell)) return chatShellSnapshot(chat);
  const current = shell.value;
  if (current.snapshotSequence >= chat.sequence) return null;
  return {
    ...current,
    snapshotSequence: chat.sequence,
    projects: upsertById(current.projects, chat.project),
    threads:
      chat.thread.archivedAt === null
        ? upsertById(current.threads, chat.thread)
        : current.threads.filter(({ id }) => id !== chat.thread.id),
    archivedThreads: current.archivedThreads.filter(({ id }) => id !== chat.thread.id),
  };
}

function upsertById<A extends { readonly id: string }>(
  values: ReadonlyArray<A>,
  next: A,
): ReadonlyArray<A> {
  return values.some(({ id }) => id === next.id)
    ? values.map((value) => (value.id === next.id ? next : value))
    : [...values, next];
}
