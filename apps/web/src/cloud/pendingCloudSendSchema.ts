import { ModelSelection } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * A draft's first cloud send that has already left the composer: the held message and where
 * its cloud machine's setup stands. Persisted with the draft, so a reload picks the send back up.
 */
export const PendingCloudEnvironmentSend = Schema.Struct({
  provider: Schema.Literals(["e2b", "namespace"]),
  preview: Schema.String,
  messageId: Schema.String,
  createdAt: Schema.String,
  prompt: Schema.String,
  outgoingMessageText: Schema.String,
  phase: Schema.Literals(["creating", "pairing", "loading-project", "ready", "failed"]),
  startedAt: Schema.String,
  endedAt: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  /** The branch the environment starts from; absent is the repository's default. */
  branch: Schema.optionalKey(Schema.String),
  readyEnvironmentId: Schema.optionalKey(Schema.String),
  /** The model the held message goes out on once the environment is ready. */
  modelSelection: Schema.optionalKey(ModelSelection),
  /** The environment's host started the held message itself; the page never sends it. */
  hostStartedFirstTurn: Schema.optionalKey(Schema.Boolean),
});
export type PendingCloudEnvironmentSend = typeof PendingCloudEnvironmentSend.Type;
const decodeModelSelectionOption = Schema.decodeUnknownOption(ModelSelection);

export function pendingEnvironmentSendsEqual(
  left: PendingCloudEnvironmentSend | null | undefined,
  right: PendingCloudEnvironmentSend | null | undefined,
): boolean {
  if (left == null && right == null) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return (
    left.provider === right.provider &&
    left.preview === right.preview &&
    left.messageId === right.messageId &&
    left.createdAt === right.createdAt &&
    left.prompt === right.prompt &&
    left.outgoingMessageText === right.outgoingMessageText &&
    left.phase === right.phase &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.error === right.error &&
    left.repository === right.repository &&
    left.branch === right.branch &&
    left.readyEnvironmentId === right.readyEnvironmentId &&
    left.hostStartedFirstTurn === right.hostStartedFirstTurn &&
    Equal.equals(left.modelSelection, right.modelSelection)
  );
}

/** A persisted pending send, or undefined when the stored value is not one. */
export function parsePendingEnvironmentSend(
  value: unknown,
): PendingCloudEnvironmentSend | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const pending = value as Record<string, unknown>;
  if (pending.provider !== "e2b" && pending.provider !== "namespace") {
    return undefined;
  }
  if (typeof pending.preview !== "string") {
    return undefined;
  }
  if (typeof pending.messageId !== "string" || pending.messageId.length === 0) {
    return undefined;
  }
  if (typeof pending.createdAt !== "string" || pending.createdAt.length === 0) {
    return undefined;
  }
  if (typeof pending.prompt !== "string") {
    return undefined;
  }
  if (typeof pending.outgoingMessageText !== "string") {
    return undefined;
  }
  if (
    pending.phase !== "creating" &&
    pending.phase !== "pairing" &&
    pending.phase !== "loading-project" &&
    pending.phase !== "ready" &&
    pending.phase !== "failed"
  ) {
    return undefined;
  }
  if (typeof pending.startedAt !== "string" || pending.startedAt.length === 0) {
    return undefined;
  }
  const modelSelection = Option.getOrUndefined(decodeModelSelectionOption(pending.modelSelection));
  return {
    provider: pending.provider,
    preview: pending.preview,
    messageId: pending.messageId,
    createdAt: pending.createdAt,
    prompt: pending.prompt,
    outgoingMessageText: pending.outgoingMessageText,
    phase: pending.phase,
    startedAt: pending.startedAt,
    ...(typeof pending.endedAt === "string" ? { endedAt: pending.endedAt } : {}),
    ...(typeof pending.error === "string" ? { error: pending.error } : {}),
    ...(typeof pending.repository === "string" ? { repository: pending.repository } : {}),
    ...(typeof pending.branch === "string" ? { branch: pending.branch } : {}),
    ...(typeof pending.readyEnvironmentId === "string" && pending.readyEnvironmentId.length > 0
      ? { readyEnvironmentId: pending.readyEnvironmentId }
      : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(pending.hostStartedFirstTurn === true ? { hostStartedFirstTurn: true } : {}),
  };
}
