import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A cloud-side Promise call rejected. Callers log it and carry on, so `cause` keeps the original. */
export class CloudPromiseError extends Schema.TaggedError<CloudPromiseError>()(
  "CloudPromiseError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Cloud operation ${this.operation} failed.`;
  }
}

export const tryCloudPromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new CloudPromiseError({ operation, cause }) });
