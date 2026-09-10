import * as Schema from "effect/Schema";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ComputeState = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["running", "stopped"]), observedAt: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("unavailable"), message: Schema.String }),
]);
export type ComputeState = typeof ComputeState.Type;
export const ManagedEnvironment = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  provider: Schema.Literals(["e2b", "namespace"]),
  state: ComputeState,
});
export type ManagedEnvironment = typeof ManagedEnvironment.Type;
export const EnvironmentControlList = Schema.Array(ManagedEnvironment);
export const EnvironmentControlInput = Schema.Struct({ environmentId: EnvironmentId });
export const EnvironmentControlResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("updated"), environment: ManagedEnvironment }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["busy", "unknown", "stale", "unprepared", "unsupported", "conflict"]),
    message: Schema.String,
  }),
]);
export type EnvironmentControlResult = typeof EnvironmentControlResult.Type;
export class EnvironmentControlError extends Schema.TaggedError<EnvironmentControlError>()(
  "EnvironmentControlError",
  { message: Schema.String },
) {}
