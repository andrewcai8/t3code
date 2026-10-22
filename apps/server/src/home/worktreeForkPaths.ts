// @effect-diagnostics nodeBuiltinImport:off - checks and moves real files on this host.
/**
 * Which host paths `t3 fork-exec --input/--output` may name, and how outputs a copy packed come
 * back. A copy runs code nobody vetted, so what it sends back is checked in a scratch directory
 * first, and each output then replaces its host path whole or not at all.
 *
 * @module worktreeForkPaths
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** `path` with symlinks resolved as far as it exists, so a link cannot hide where it points. */
const resolved = (path: string): string => {
  const missing: Array<string> = [];
  for (let at = path; ; at = NodePath.dirname(at)) {
    try {
      return NodePath.join(NodeFS.realpathSync(at), ...missing.toReversed());
    } catch {
      if (at === "/") return path;
      missing.push(NodePath.basename(at));
    }
  }
};

/**
 * Why a copy may not be given `path` or write it back here, or null. T3 home holds this server's
 * state, secrets and fork socket, so neither it, anything in it, nor a directory holding it
 * crosses; nor does the whole home directory come back as an output.
 */
export const refusedPath = (
  path: string,
  direction: "input" | "output",
  t3Home: string,
  userHome: string,
): string | null => {
  const target = resolved(path);
  const home = resolved(t3Home);
  if (inside(target, home) || inside(home, target))
    return `${path} is or holds this server's T3 home, which a copy may not ${direction === "input" ? "read" : "write"}.`;
  if (direction === "output" && target === resolved(userHome))
    return `${path} is the home directory, which an output may not replace.`;
  return null;
};

/**
 * Moves the outputs unpacked under `staging` (each at its own path below it) to their host paths.
 * Refuses everything unless each entry is a plain file or directory within a requested path, or a
 * directory leading to one. Each output replaces its host path whole; if any move fails, every
 * host path is left as it was. Returns the outputs placed; one missing under `staging` is skipped.
 */
export const placeOutputs = (
  staging: string,
  paths: ReadonlyArray<string>,
  tag: string,
): ReadonlyArray<string> => {
  const check = (dir: string) => {
    for (const name of NodeFS.readdirSync(dir)) {
      const full = NodePath.join(dir, name);
      const path = `/${NodePath.relative(staging, full)}`;
      const requested = paths.some((output) => inside(path, output));
      const stat = NodeFS.lstatSync(full);
      if (stat.isDirectory() && (requested || paths.some((output) => inside(output, path))))
        check(full);
      else if (!requested) throw new Error(`${path} is not a requested output.`);
      else if (!stat.isFile() || stat.nlink > 1)
        throw new Error(`${path} is not a plain file or directory.`);
    }
  };
  check(staging);

  const moves = paths.flatMap((path) => {
    const staged = NodePath.join(staging, path);
    return NodeFS.existsSync(staged)
      ? [{ path, staged, next: `${path}.t3-new-${tag}`, previous: `${path}.t3-old-${tag}` }]
      : [];
  });
  const exists = (path: string) => NodeFS.lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  const swapped: Array<(typeof moves)[number] & { readonly hadPrevious: boolean }> = [];
  try {
    // Beside each target first, so the swap below is a rename within one filesystem.
    for (const move of moves) {
      NodeFS.mkdirSync(NodePath.dirname(move.path), { recursive: true });
      try {
        NodeFS.renameSync(move.staged, move.next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        NodeFS.cpSync(move.staged, move.next, { recursive: true });
      }
    }
    for (const move of moves) {
      const hadPrevious = exists(move.path);
      if (hadPrevious) NodeFS.renameSync(move.path, move.previous);
      try {
        NodeFS.renameSync(move.next, move.path);
      } catch (error) {
        if (hadPrevious) NodeFS.renameSync(move.previous, move.path);
        throw error;
      }
      swapped.push({ ...move, hadPrevious });
    }
  } catch (error) {
    for (const move of swapped.toReversed()) {
      NodeFS.rmSync(move.path, { recursive: true, force: true });
      if (move.hadPrevious) NodeFS.renameSync(move.previous, move.path);
    }
    for (const move of moves) NodeFS.rmSync(move.next, { recursive: true, force: true });
    throw error;
  }
  for (const move of swapped) NodeFS.rmSync(move.previous, { recursive: true, force: true });
  return moves.map((move) => move.path);
};
