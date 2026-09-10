// @effect-diagnostics nodeBuiltinImport:off - private configuration is loaded at the Promise-based SDK boundary.
import * as NodeFSP from "node:fs/promises";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const E2bIdentity = Schema.Struct({
  sandboxId: TrimmedNonEmptyString,
  metadata: Schema.Record(Schema.String, Schema.String),
});
const Target = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  hostId: TrimmedNonEmptyString,
  operatorToken: TrimmedNonEmptyString,
  machine: Schema.Union([
    Schema.Struct({ provider: Schema.Literal("e2b"), ...E2bIdentity.fields }),
    Schema.Struct({
      provider: Schema.Literal("namespace"),
      name: TrimmedNonEmptyString,
      devboxId: TrimmedNonEmptyString,
      volumeName: TrimmedNonEmptyString,
      region: TrimmedNonEmptyString,
    }),
  ]),
});
export const EnvironmentControlConfig = Schema.Struct({
  e2bApiKey: TrimmedNonEmptyString,
  namespaceToken: Schema.optional(TrimmedNonEmptyString),
  broker: Schema.Struct({
    ...E2bIdentity.fields,
    url: TrimmedNonEmptyString,
    ingressKey: TrimmedNonEmptyString,
  }),
  targets: Schema.Array(Target),
});
export type EnvironmentControlConfig = typeof EnvironmentControlConfig.Type;
export type ManagedTarget = typeof Target.Type;
const decodeConfig = Schema.decodeUnknownSync(EnvironmentControlConfig);

export async function readConfig(path: string): Promise<EnvironmentControlConfig> {
  const config = decodeConfig(JSON.parse(await NodeFSP.readFile(path, "utf8")));
  const url = new URL(config.broker.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Controller requires a private HTTPS endpoint");
  if (
    new Set(config.targets.map((target) => target.environmentId)).size !== config.targets.length ||
    new Set(config.targets.map((target) => target.hostId)).size !== config.targets.length
  )
    throw new Error("Duplicate managed environment");
  for (const target of config.targets) {
    if (!/^[a-zA-Z0-9_-]+$/.test(target.hostId) || target.operatorToken.length < 32)
      throw new Error("Invalid controller identity");
  }
  for (const identity of [
    config.broker,
    ...config.targets.flatMap((target) =>
      target.machine.provider === "e2b" ? [target.machine] : [],
    ),
  ]) {
    if (!Object.keys(identity.metadata).length)
      throw new Error("Sandbox ownership metadata required");
  }
  return config;
}
