#!/usr/bin/env node

/**
 * Fails when two source files in one directory resolve to the same module specifier on a
 * case-insensitive filesystem.
 *
 * TypeScript resolves `./Foo` by stem, so `Foo.tsx` beside `foo.ts` is one module on macOS and
 * Windows and two on Linux. CI runs on Linux, where the collision is invisible, so nothing else
 * in the pipeline can catch it. The repository's own convention of a `Component.tsx` beside its
 * `componentLogic.ts` keeps walking up to this edge, which is why this is a check rather than a
 * note to reviewers.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";

const RESOLVABLE: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Build output and vendored references are not ours to rename, and CI's sparse checkout omits
 * `.repos/`, so scanning them would make this check disagree with the one CI runs. Dot
 * directories carry tool state rather than source.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "ios",
  "android",
]);

function skipDirectory(name: string): boolean {
  return name.startsWith(".") || SKIPPED_DIRECTORIES.has(name);
}

const collectSourceFiles = Effect.fn("collectSourceFiles")(function* (
  root: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<string> = [];
  const pending: Array<string> = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const entries = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries) {
      const full = path.join(directory, entry);
      const info = yield* fs.stat(full).pipe(Effect.option);
      if (info._tag === "None") continue;
      if (info.value.type === "Directory") {
        if (!skipDirectory(entry)) pending.push(full);
        continue;
      }
      if (RESOLVABLE.has(path.extname(entry))) found.push(full);
    }
  }
  return found;
});

/** Directory plus the case-folded stem, which is exactly what a module specifier resolves by. */
const specifierKey = (path: Path.Path, file: string): string =>
  `${path.dirname(file)}/${path.basename(file, path.extname(file)).toLowerCase()}`;

export const findCollisions = (
  path: Path.Path,
  files: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const byKey = new Map<string, Array<string>>();
  for (const file of files) {
    const key = specifierKey(path, file);
    const group = byKey.get(key);
    if (group) group.push(file);
    else byKey.set(key, [file]);
  }
  const found: Array<ReadonlyArray<string>> = [];
  for (const group of byKey.values()) {
    // Same stem spelled the same way is an ordinary sibling such as `Foo.ts` and `Foo.test.ts`.
    // Only differing spellings collapse into one specifier when case stops mattering.
    const spellings = new Set(group.map((file) => path.basename(file, path.extname(file))));
    if (spellings.size > 1) found.push([...group].sort());
  }
  return found.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
};

const checkCaseCollisions = Effect.fn("checkCaseCollisions")(function* () {
  const path = yield* Path.Path;
  const root = process.cwd();
  const files = yield* collectSourceFiles(root);
  const found = findCollisions(path, files);
  if (found.length === 0) {
    yield* Console.log("No case-only module collisions.");
    return;
  }
  yield* Console.error(
    `Found ${found.length} case-only module collision${found.length === 1 ? "" : "s"}.`,
  );
  yield* Console.error(
    "Each group resolves to one module on macOS and Windows, and to separate modules on Linux.",
  );
  yield* Console.error("Rename one file so the stems differ by more than case.");
  for (const group of found)
    for (const file of group) yield* Console.error(`  ${path.relative(root, file)}`);
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

export const checkCaseCollisionsCommand = Command.make("check-case-collisions", {}, () =>
  checkCaseCollisions(),
).pipe(Command.withDescription("Fail when two modules differ only by the case of their stem."));

if (import.meta.main) {
  Command.run(checkCaseCollisionsCommand, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
    NodeRuntime.runMain,
  );
}
