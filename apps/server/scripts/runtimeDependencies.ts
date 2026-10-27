import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

import { selectCliRuntimeExternalDependencies } from "../../../scripts/lib/cli-external-packages.ts";

const Edges = Schema.optional(Schema.Record(Schema.String, Schema.String));

export const PnpmLock = Schema.Struct({
  importers: Schema.Record(
    Schema.String,
    Schema.Struct({
      dependencies: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ version: Schema.String })),
      ),
    }),
  ),
  snapshots: Schema.Record(
    Schema.String,
    Schema.Struct({ dependencies: Edges, optionalDependencies: Edges }),
  ),
});
export type PnpmLock = typeof PnpmLock.Type;

/**
 * pnpm 11+ writes the package manager's own lockfile as a first YAML document (`importers` holds
 * only `.` and pnpm itself), so the workspace lockfile is the last document.
 */
export const decodePnpmLock = (text: string): PnpmLock =>
  Schema.decodeSync(fromYaml(PnpmLock))(text.split(/^---$/m).at(-1) ?? text);

// pnpm references carry peer and patch suffixes: `2.2.0(@bufbuild/protobuf@2.16.0)`.
const versionOf = (reference: string) => reference.replace(/\(.*$/, "");

/**
 * The npm manifest that installs exactly what the repo's pnpm lockfile tested.
 * npm cannot read pnpm-lock.yaml, so each runtime external that pnpm resolved to one version is
 * pinned with an override. Packages pnpm holds at several versions are left to npm, because a nested
 * override leaks into peers; `findUntestedPackages` catches it if that drifts.
 */
export function resolveRuntimeDependencies(lock: PnpmLock, importer: string) {
  const declared = lock.importers[importer]?.dependencies ?? {};
  const roots = selectCliRuntimeExternalDependencies(
    Object.fromEntries(Object.entries(declared).map(([name, { version }]) => [name, version])),
  );
  const versions = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const queue = Object.entries(roots);
  for (const [name, reference] of queue) {
    const key = `${name}@${reference}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const snapshot = lock.snapshots[key];
    if (snapshot === undefined) throw new Error(`pnpm-lock.yaml has no snapshot for ${key}`);
    versions.set(name, (versions.get(name) ?? new Set()).add(versionOf(reference)));
    queue.push(...Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies }));
  }
  const dependencies = Object.fromEntries(
    Object.entries(roots).map(([name, reference]) => [name, versionOf(reference)]),
  );
  const overrides: Record<string, string> = {};
  for (const [name, [version, ...others]] of versions) {
    if (version !== undefined && others.length === 0 && !(name in dependencies))
      overrides[name] = version;
  }
  return { dependencies, overrides, versions };
}

/** Every package in an npm lockfile whose version pnpm did not resolve, as `name@version`. */
export function findUntestedPackages(
  packageLock: { readonly packages: Record<string, { readonly version?: string }> },
  versions: ReadonlyMap<string, ReadonlySet<string>>,
): Array<string> {
  return Object.entries(packageLock.packages).flatMap(([path, { version }]) => {
    if (path === "") return [];
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    return version !== undefined && versions.get(name)?.has(version) ? [] : [`${name}@${version}`];
  });
}
