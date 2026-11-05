/**
 * storage-blob-fs: `storage.blob` (@pikit/contracts' blob.ts) in a directory, `.pikit/blobs` by
 * default: what components keep by key that is too large for a row (saved files, snapshots).
 *
 * - **One directory per namespace**, `<root>/<namespace>/`, and one file per key under it. A key's
 *   segments are directories, so `ls` shows its tree: `spaces/s1/notes.md` is
 *   `spaces~/s1~/notes.md`. A directory's name ends in `~` (`+` for a segment longer than one name
 *   holds, cut in pieces of 200), a value's file has no suffix, so a key and the keys under it (`a`,
 *   `a/b`) are a file and a directory. An upper-case letter is written `^` and the letter in lower
 *   case (`README` is `^r^e^a^d^m^e`), so two keys that differ only in case are two files on a file
 *   system that ignores case (macOS's, Windows').
 * - **Atomic replace**: `put` writes the value to a temporary file (`#<uuid>`, in the same
 *   directory), syncs it, then renames it over the key's file. A reader opens the old file or the new
 *   one, never a mix; a crash leaves the old value (and, at worst, a temporary file nothing lists).
 * - **The content type beside the value, in the same file**: a header of 256 bytes (its length, then
 *   its characters) before the value's bytes, so one rename replaces both.
 * - **List** walks the namespace's directories that can hold keys with the prefix (and after the
 *   cursor), then sorts what it found in code-unit order: a page costs a walk of that part of the
 *   tree. The cursor is the page's last key.
 * - **Nothing outside the root**: the contract's keys and namespace names cannot leave it, and every
 *   path is checked to be inside its namespace's directory before it is used. Symbolic links are never
 *   followed when listing. A key, a value or a content type the contract refuses is refused before
 *   any file is touched.
 * - `put` and `get` hold a value whole, in memory (`maxBytes`, 25 MiB by default). `putStream`
 *   writes the chunks to the temporary file as they come (hashed with `node:crypto`), then syncs and
 *   renames it as `put` does: a body that fails, is larger than `maxStreamBytes` (1 TiB by default)
 *   or has another SHA-256 removes the temporary file and leaves the key as it was. `getStream` reads
 *   the file it opened, a piece at a time: a value replaced meanwhile is still read whole (the open
 *   file is the old one).
 *
 * Target: `server` (it uses a file system).
 */

import { createHash } from "node:crypto";
import { type FileHandle, mkdir, open, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { defineComponent } from "@pikit/core";
import {
  BLOB_MIN_MAX_BYTES,
  type BlobEntry,
  type BlobHash,
  type BlobStorage,
  type BlobStore,
  BlobTooLargeError,
  blobKeyProblem,
  blobListLimit,
  blobStreamChunks,
  checkBlobKey,
  checkBlobNamespace,
  checkBlobPut,
  checkBlobPutStream,
} from "@pikit/contracts";
import Type from "typebox";

const Config = Type.Object({
  /** The directory every namespace is kept in, relative to the working directory. */
  root: Type.String({ minLength: 1, default: ".pikit/blobs" }),
  /** The largest value it keeps, in bytes: at least 25 MiB. Values are held whole in memory. */
  maxBytes: Type.Integer({ minimum: BLOB_MIN_MAX_BYTES, default: BLOB_MIN_MAX_BYTES }),
  /** The largest value `putStream` writes, in bytes: at least `maxBytes`. Streams are never held whole. */
  maxStreamBytes: Type.Integer({ minimum: BLOB_MIN_MAX_BYTES, default: 2 ** 40 }),
});

/** How much of a file `getStream` reads at a time. */
const READ_CHUNK = 1024 * 1024;

/** `node:crypto`'s SHA-256, for `blobStreamChunks`: far faster than the plain one. */
const nodeHash = (): BlobHash => {
  const hash = createHash("sha256");
  return { update: (bytes) => void hash.update(bytes), digest: () => hash.digest("hex") };
};

/** The header of a value: the content type's length, then its characters. */
function header(contentType: string | undefined): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  if (contentType !== undefined) {
    bytes[0] = contentType.length;
    bytes.set(new TextEncoder().encode(contentType), 1);
  }
  return bytes;
}

/** The content type in a value's header, read from its first `HEADER_BYTES`. */
function headerType(bytes: Uint8Array): string | undefined {
  const length = bytes[0] as number;
  return length > 0 ? String.fromCharCode(...bytes.subarray(1, 1 + length)) : undefined;
}

/** The bytes before a value: the content type's length, then its characters (at most 255). */
export const HEADER_BYTES = 256;
/** The longest name a piece of a segment takes, well under every file system's 255 bytes. */
const PIECE = 200;
/** A directory's suffix when the next segment follows. */
const CHILDREN = "~";
/** A directory's suffix when the same segment goes on in it. */
const CONTINUES = "+";
/** The first character of a temporary file's name, never of a key's. */
const TEMPORARY = "#";
/** A name it writes for a piece: the key's characters, an upper-case letter as `^` and the letter. */
const PIECE_NAME = /^(?:[a-z0-9!\-_.*'()]|\^[a-z])+$/;

/** `segment` in pieces of at most `PIECE` characters, as written: an upper-case letter as `^` and the letter. */
function pieces(segment: string): string[] {
  const out: string[][] = [[]];
  let length = 0;
  for (const char of segment) {
    const unit = char >= "A" && char <= "Z" ? `^${char.toLowerCase()}` : char;
    if (length + unit.length > PIECE) {
      out.push([]);
      length = 0;
    }
    (out[out.length - 1] as string[]).push(unit);
    length += unit.length;
  }
  // A last piece "." or ".." would name the directory itself or its parent: it takes from the one before.
  for (let last = out[out.length - 1] as string[]; out.length > 1 && /^\.{1,2}$/.test(last.join("")); ) {
    last.unshift((out[out.length - 2] as string[]).pop() as string);
  }
  return out.map((piece) => piece.join(""));
}

/** The names from a namespace's directory to the file of `key` (a key the contract takes). */
export function fileNames(key: string): string[] {
  const segments = key.split("/");
  return segments.flatMap((segment, i) => {
    const parts = pieces(segment);
    return parts.map((part, j) => (j < parts.length - 1 ? `${part}${CONTINUES}` : i < segments.length - 1 ? `${part}${CHILDREN}` : part));
  });
}

const decode = (piece: string): string => piece.replace(/\^([a-z])/g, (_, letter: string) => letter.toUpperCase());

const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
/** A path that is not there: missing, or one of its directories is a file. */
const missing = (error: unknown): boolean => codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR";

const byKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

export default defineComponent({
  name: "storage-blob-fs",
  config: Config,
  setup(pikit, config) {
    if (config.maxStreamBytes < config.maxBytes) throw new Error(`storage-blob-fs: maxStreamBytes (${config.maxStreamBytes}) is smaller than maxBytes (${config.maxBytes})`);
    /** The root's absolute path, from start to stop. */
    let root: string | undefined;
    /**
     * Runs `work` after every structural step queued before it: making a directory and the temporary
     * file in it (put), or removing a file and the directories it emptied (delete). Writing a value's
     * bytes runs outside it.
     */
    let line: Promise<unknown> = Promise.resolve();
    const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
      const next = line.then(work);
      line = next.catch(() => {});
      return next;
    };
    const live = (): string => {
      if (root === undefined) throw new Error("storage-blob-fs: storage.blob used while the app is not running");
      return root;
    };

    /** `<root>/<name>`, checked to be inside the root. */
    const directoryOf = (name: string): string => {
      const base = live();
      const directory = resolve(base, name);
      if (!directory.startsWith(base + sep)) throw new Error(`storage-blob-fs: the namespace ${JSON.stringify(name)} is outside ${base}`);
      return directory;
    };
    /** The file of `key` in `directory`, checked to be inside it. */
    const fileOf = (directory: string, key: string): string => {
      const file = resolve(directory, ...fileNames(key));
      if (!file.startsWith(directory + sep)) throw new Error(`storage-blob-fs: the key ${JSON.stringify(key)} is outside ${directory}`);
      return file;
    };

    /**
     * Writes a value with `write` to a temporary file (`#<uuid>`) beside the key's, syncs it and
     * renames it over the key's file: a reader opens the old file or the new one. When `write` fails
     * the temporary file is removed and the key is as it was.
     */
    const replace = async (name: string, key: string, write: (handle: FileHandle) => Promise<unknown>): Promise<void> => {
      const file = fileOf(directoryOf(name), key);
      const directory = dirname(file);
      for (let attempt = 1; ; attempt++) {
        const temporary = join(directory, `${TEMPORARY}${crypto.randomUUID()}`);
        let opened = false;
        try {
          // Once the temporary file is there, no delete empties (and removes) its directory.
          const handle = await exclusive(async () => {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            return await open(temporary, "wx", 0o600);
          });
          opened = true;
          try {
            await write(handle);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temporary, file);
          return;
        } catch (error) {
          await unlink(temporary).catch(() => {});
          // Another process's delete removed the directory it emptied between mkdir and open
          // (ENOENT; EINVAL on macOS): make it again. Never once writing started (a stream is read once).
          if (opened || (!missing(error) && codeOf(error) !== "EINVAL") || attempt === 5) throw error;
        }
      }
    };

    /** The file of a value, open, with its size and content type; `undefined` when it is missing. */
    const openValue = async (file: string): Promise<{ handle: FileHandle; size: number; contentType: string | undefined } | undefined> => {
      let handle: FileHandle;
      try {
        handle = await open(file, "r");
      } catch (error) {
        if (missing(error) || codeOf(error) === "EISDIR") return undefined;
        throw error;
      }
      try {
        const { size } = await handle.stat();
        if (size < HEADER_BYTES) throw new Error(`storage-blob-fs: ${file} is not a value it wrote (shorter than its header)`);
        const head = new Uint8Array(HEADER_BYTES);
        await handle.read(head, 0, HEADER_BYTES, 0);
        return { handle, size: size - HEADER_BYTES, contentType: headerType(head) };
      } catch (error) {
        await handle.close();
        throw error;
      }
    };

    const store = (name: string): BlobStore => ({
      async put(key, bytes, options) {
        const contentType = options?.contentType;
        checkBlobPut(key, bytes, contentType, config.maxBytes);
        // The header and a copy of the bytes, before anything is awaited: the caller may change its array.
        const content = new Uint8Array(HEADER_BYTES + bytes.byteLength);
        content.set(header(contentType));
        content.set(bytes, HEADER_BYTES);
        await replace(name, key, (handle) => handle.writeFile(content));
      },

      async putStream(key, body, options) {
        checkBlobPutStream(key, body, options);
        const read = blobStreamChunks(body, { maxStreamBytes: config.maxStreamBytes, hash: nodeHash, ...(options?.sha256 !== undefined && { sha256: options.sha256 }) });
        // Written to the temporary file as they come; renamed over the key's only once the body ended, checked.
        await replace(name, key, async (handle) => {
          await handle.write(header(options?.contentType));
          for await (const chunk of read.chunks) await handle.write(chunk);
        });
        return read.stored();
      },

      async getStream(key) {
        checkBlobKey(key);
        const opened = await openValue(fileOf(directoryOf(name), key));
        if (opened === undefined) return undefined;
        const { handle, size, contentType } = opened;
        let at = HEADER_BYTES;
        const end = HEADER_BYTES + size;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              if (at >= end) {
                await handle.close();
                return controller.close();
              }
              const chunk = new Uint8Array(Math.min(READ_CHUNK, end - at));
              const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, at);
              if (bytesRead === 0) throw new Error(`storage-blob-fs: ${key} ended before its ${size} bytes`);
              at += bytesRead;
              controller.enqueue(chunk.subarray(0, bytesRead));
            } catch (error) {
              await handle.close().catch(() => {});
              controller.error(error);
            }
          },
          async cancel() {
            await handle.close().catch(() => {});
          },
        });
        return { body, size, ...(contentType !== undefined && { contentType }) };
      },

      async get(key) {
        checkBlobKey(key);
        const opened = await openValue(fileOf(directoryOf(name), key));
        if (opened === undefined) return undefined;
        const { handle, size, contentType } = opened;
        try {
          if (size > config.maxBytes) throw new BlobTooLargeError(size, config.maxBytes);
          const bytes = new Uint8Array(size);
          for (let at = 0; at < size; ) {
            const { bytesRead } = await handle.read(bytes, at, size - at, HEADER_BYTES + at);
            if (bytesRead === 0) throw new Error(`storage-blob-fs: ${key} ended before its ${size} bytes`);
            at += bytesRead;
          }
          return { bytes, ...(contentType !== undefined && { contentType }) };
        } finally {
          await handle.close();
        }
      },

      async delete(key) {
        checkBlobKey(key);
        const directory = directoryOf(name);
        const file = fileOf(directory, key);
        await exclusive(async () => {
          try {
            await unlink(file);
          } catch (error) {
            if (missing(error)) return;
            throw error;
          }
          // The directories it emptied go too, up to the namespace's: a tree of deleted keys leaves nothing.
          for (let parent = dirname(file); parent.startsWith(directory + sep); parent = dirname(parent)) {
            try {
              await rmdir(parent);
            } catch {
              break;
            }
          }
        });
      },

      async list(prefix, options) {
        const limit = blobListLimit(options?.limit);
        if (typeof prefix !== "string") throw new TypeError("storage-blob-fs: a list's prefix is a string");
        const after = options?.cursor;
        const found: { key: string; file: string }[] = [];
        await walk(directoryOf(name), "", prefix, after, found);
        found.sort(byKey);
        const page = found.slice(0, limit);
        const entries: BlobEntry[] = [];
        for (const { key, file } of page) {
          try {
            entries.push({ key, size: (await stat(file)).size - HEADER_BYTES });
          } catch (error) {
            // Deleted since the walk: not listed, as the contract allows.
            if (!missing(error)) throw error;
          }
        }
        return { entries, ...(found.length > limit && { cursor: (page[page.length - 1] as { key: string }).key }) };
      },
    });

    const storage: BlobStorage = {
      maxBytes: config.maxBytes,
      maxStreamBytes: config.maxStreamBytes,
      namespace(name) {
        checkBlobNamespace(name);
        return store(name);
      },
    };
    pikit.provide("storage.blob", storage);

    return {
      async start() {
        const directory = resolve(config.root);
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          if (!(await stat(directory)).isDirectory()) throw new Error("not a directory");
        } catch (error) {
          throw new Error(`storage-blob-fs: cannot keep values in ${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
        root = directory;
      },
      stop() {
        root = undefined;
      },
    };
  },
});

/**
 * Adds to `found` every key under `directory` (whose keys start with `start`) that starts with
 * `prefix` and comes after `after`, with its file. Skips what it did not write: temporary files,
 * symbolic links, names that are not pieces (`.DS_Store`).
 */
async function walk(directory: string, start: string, prefix: string, after: string | undefined, found: { key: string; file: string }[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      const suffix = name.slice(-1);
      const piece = name.slice(0, -1);
      if ((suffix !== CHILDREN && suffix !== CONTINUES) || !PIECE_NAME.test(piece)) continue;
      const next = `${start}${decode(piece)}${suffix === CHILDREN ? "/" : ""}`;
      // Every key under it starts with `next`: skip it when none can start with the prefix, or all come before the cursor.
      if (!next.startsWith(prefix) && !prefix.startsWith(next)) continue;
      if (after !== undefined && next < after && !after.startsWith(next)) continue;
      await walk(join(directory, name), next, prefix, after, found);
    } else if (entry.isFile() && PIECE_NAME.test(name)) {
      const key = `${start}${decode(name)}`;
      if (!key.startsWith(prefix) || (after !== undefined && key <= after) || blobKeyProblem(key) !== undefined) continue;
      found.push({ key, file: join(directory, name) });
    }
  }
}
