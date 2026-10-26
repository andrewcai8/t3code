// @effect-diagnostics nodeBuiltinImport:off - hashes this host's files and the archives packed from them.
/**
 * The key an upload is cached under: the sha256 of what a copy unpacks, read two ways that must
 * agree. `contentKey` reads the host's files; `archiveKey` reads the archive tar packed. A file that
 * changed while tar read it yields a differing key, so it serves its own job and is never cached.
 *
 * @module worktreeForkContent
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { fileDigest } from "../environmentControl/ProvisionPreparation.ts";

/** Each entry's description, by the path it unpacks at, from which a key is taken. */
type Entries = Map<string, string>;

const entryName = (name: string) => name.replace(/\/+$/, "");

const keyOf = (context: ReadonlyArray<string>, entries: Entries) => {
  const hash = NodeCrypto.createHash("sha256").update(`${context.length}\0${context.join("\0")}\0`);
  for (const name of [...entries.keys()].toSorted()) {
    const line = `${name}\0${entries.get(name)!}`;
    hash.update(`${line.length}:${line}`);
  }
  return hash.digest("hex");
};

/**
 * Files whose content an earlier hash read, by path, while their inode, size, times and mode stay
 * as they were. A write changes ctime, which nothing can set back, so a hit is the same content;
 * a file changed in the last two seconds could change again within the same tick, so it is not kept.
 */
const digests = new Map<string, { readonly stat: string; readonly digest: string }>();
const MAX_DIGESTS = 50_000;
const RACY_MS = 2_000;

const digestOf = async (path: string, stat: NodeFS.BigIntStats, now: number) => {
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(
    ":",
  );
  const known = digests.get(path);
  if (known?.stat === signature) return known.digest;
  const digest = await fileDigest(path);
  if (now - Number(stat.ctimeMs) > RACY_MS) {
    digests.delete(path);
    digests.set(path, { stat: signature, digest });
    if (digests.size > MAX_DIGESTS) digests.delete(digests.keys().next().value!);
  }
  return digest;
};

/** Adds `path`, unpacked at `name`, as tar would pack it; a path that is gone packs as nothing. */
const addTree = async (entries: Entries, name: string, path: string, now: number) => {
  const stat = NodeFS.lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (stat === undefined) return;
  const mode = (stat.mode & 0o7777n).toString(8);
  if (stat.isSymbolicLink()) return void entries.set(name, `link\0${NodeFS.readlinkSync(path)}`);
  if (stat.isFile())
    return void entries.set(name, `file\0${mode}\0${await digestOf(path, stat, now)}`);
  if (!stat.isDirectory()) return void entries.set(name, "other");
  entries.set(name, `dir\0${mode}`);
  for (const child of NodeFS.readdirSync(path))
    await addTree(entries, `${name}/${child}`, NodePath.join(path, child), now);
};

/** The key of `context` and each host path as it would unpack at `name`. */
export const contentKey = Effect.fnUntraced(function* (
  context: ReadonlyArray<string>,
  paths: ReadonlyArray<{ readonly name: string; readonly path: string }>,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.tryPromise(async () => {
    const entries: Entries = new Map();
    for (const { name, path } of paths) await addTree(entries, entryName(name), path, now);
    return keyOf(context, entries);
  });
});

/** Reads a gzip tar's entries as they unpack: GNU long names, pax paths and hard links included. */
const readArchive = async (archive: string, unpackedAt: (name: string) => string) => {
  const entries: Entries = new Map();
  const contentByName = new Map<string, string>();
  const source = NodeFS.createReadStream(archive).pipe(NodeZlib.createGunzip());
  const chunks = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let pending: Buffer = Buffer.alloc(0);
  const more = async () => {
    const next = await chunks.next();
    if (next.done) throw new Error("The archive ends early.");
    pending = pending.length === 0 ? next.value : Buffer.concat([pending, next.value]);
  };
  const take = async (size: number) => {
    while (pending.length < size) await more();
    const taken = pending.subarray(0, size);
    pending = pending.subarray(size);
    return taken;
  };
  const stream = async (size: number, onChunk: (chunk: Buffer) => void) => {
    for (let left = size; left > 0;) {
      if (pending.length === 0) await more();
      const chunk = pending.subarray(0, Math.min(left, pending.length));
      onChunk(chunk);
      pending = pending.subarray(chunk.length);
      left -= chunk.length;
    }
    await take((512 - (size % 512)) % 512);
  };
  let pax: Record<string, string> = {};
  let longName: string | null = null;
  let longLink: string | null = null;
  try {
    for (;;) {
      const header = await take(512);
      if (header.every((byte) => byte === 0)) break;
      const text = (start: number, length: number) => {
        const field = header.subarray(start, start + length);
        const end = field.indexOf(0);
        return field.subarray(0, end === -1 ? length : end).toString("utf8");
      };
      const number = (start: number, length: number) => {
        if ((header[start]! & 0x80) === 0)
          return Number.parseInt(text(start, length).trim() || "0", 8);
        let value = 0;
        for (let at = start + 1; at < start + length; at += 1) value = value * 256 + header[at]!;
        return value;
      };
      const type = String.fromCharCode(header[156]!);
      if (type === "x" || type === "g" || type === "L" || type === "K") {
        const size = number(124, 12);
        const body = Buffer.alloc(size);
        let at = 0;
        await stream(size, (chunk) => void (at += chunk.copy(body, at)));
        if (type === "L") longName = body.toString("utf8").replace(/\0+$/, "");
        if (type === "K") longLink = body.toString("utf8").replace(/\0+$/, "");
        if (type === "x")
          for (let offset = 0; offset < body.length;) {
            const space = body.indexOf(0x20, offset);
            const length = Number.parseInt(body.subarray(offset, space).toString("latin1"), 10);
            if (!(length > 0)) break;
            const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
            const equals = record.indexOf("=");
            pax[record.slice(0, equals)] = record.slice(equals + 1);
            offset += length;
          }
        continue;
      }
      // A POSIX ustar header splits a long path into a prefix; GNU's keeps other fields there.
      const posix = header.subarray(257, 263).toString("latin1") === "ustar\0";
      const stored = entryName(
        pax.path ??
          longName ??
          (posix && header[345] !== 0 ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100)),
      );
      const target = pax.linkpath ?? longLink ?? text(157, 100);
      const size = pax.size === undefined ? number(124, 12) : Number(pax.size);
      pax = {};
      longName = null;
      longLink = null;
      const name = unpackedAt(stored);
      const mode = (number(100, 8) & 0o7777).toString(8);
      if (type === "0" || type === "\0" || type === "7") {
        const hash = NodeCrypto.createHash("sha256");
        await stream(size, (chunk) => void hash.update(chunk));
        const content = `file\0${mode}\0${hash.digest("hex")}`;
        contentByName.set(stored, content);
        entries.set(name, content);
        continue;
      }
      await stream(size, () => {});
      if (type === "1") entries.set(name, contentByName.get(entryName(target)) ?? "other");
      else if (type === "2") entries.set(name, `link\0${target}`);
      else if (type === "5") entries.set(name, `dir\0${mode}`);
      else entries.set(name, "other");
    }
  } finally {
    source.destroy();
  }
  return entries;
};

/** The key of `context` and what the gzip tar `archive` unpacks, each entry at `unpackedAt(name)`. */
export const archiveKey = (
  context: ReadonlyArray<string>,
  archive: string,
  unpackedAt: (name: string) => string = (name) => name,
) => Effect.tryPromise(async () => keyOf(context, await readArchive(archive, unpackedAt)));
