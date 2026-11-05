/**
 * What a workspace snapshot's archive holds, checked before it is uploaded or extracted: a gzip'd
 * POSIX tar (ustar, with pax extended headers and GNU long names read) of relative paths, each a
 * regular file, a directory or a symlink pointing inside. Anything else refuses the whole archive
 * (`ArchiveRefused`), so a snapshot written by another backend, or tampered with in the bucket, can
 * never place a file outside the workspace:
 *
 * - an absolute path, a `..` segment, a NUL, or an entry below a symlink of the same archive (extracting
 *   it would write through the link);
 * - a symlink whose target is absolute or leaves the root (resolved from the link's directory);
 * - a hard link, a device, a FIFO or any other kind;
 * - a header whose checksum is wrong, a truncated archive, or more than `maxUnpackedBytes` unpacked.
 *
 * It reads the archive as a stream (gunzip through `DecompressionStream`, a header at a time), keeping
 * only the headers: a Durable Object has 128 MB, and an archive is up to `storage.blob`'s `maxBytes`.
 */

export class ArchiveRefused extends Error {}

export interface TarEntry {
  /** Relative to the workspace's root, without `./` (`""` is the root itself). */
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  /** A symlink's target, as written. */
  linkTarget?: string;
}

const BLOCK = 512;
const decoder = new TextDecoder();

function text(block: Uint8Array, at: number, length: number): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function octal(block: Uint8Array, at: number, length: number): number {
  const field = block.subarray(at, at + length);
  // GNU's base-256 for large values: the first byte's high bit set.
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = (field[0] ?? 0) & 0x7f;
    for (let i = 1; i < field.length; i++) value = value * 256 + (field[i] ?? 0);
    return value;
  }
  const digits = text(block, at, length).trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new ArchiveRefused(`a header field is not octal: ${JSON.stringify(digits.slice(0, 20))}`);
  return Number.parseInt(digits, 8);
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  return sum === octal(block, 148, 8);
}

/** pax records: `<length> <key>=<value>\n`. */
function paxRecords(bytes: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number.parseInt(decoder.decode(bytes.subarray(at, space)), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > bytes.length) throw new ArchiveRefused("a pax header is malformed");
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals !== -1) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

/** The entry's path relative to the root, or `ArchiveRefused`. */
export function entryPath(raw: string): string {
  if (raw.includes("\0")) throw new ArchiveRefused("a path holds a NUL");
  if (raw.startsWith("/")) throw new ArchiveRefused(`an absolute path: ${JSON.stringify(raw.slice(0, 200))}`);
  const segments = raw.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new ArchiveRefused(`a path leaving the root: ${JSON.stringify(raw.slice(0, 200))}`);
  return segments.join("/");
}

/** Whether `target`, resolved from the directory of the link at `at`, stays inside the root. */
export function linkStaysInside(at: string, target: string): boolean {
  if (target === "" || target.startsWith("/") || target.includes("\0")) return false;
  const parts = at.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return false;
      parts.pop();
    } else parts.push(segment);
  }
  return true;
}

/** Reads a tar stream header by header; `feed` it bytes, then `end`. */
export class TarInspector {
  readonly entries: TarEntry[] = [];
  private pending = new Uint8Array(0);
  /** Data bytes (with padding) still to pass over. */
  private skip = 0;
  /** The data of a pax or GNU long-name entry being read, and what it is for. */
  private collecting: { kind: "pax" | "longname" | "longlink" | "global"; bytes: Uint8Array; at: number; padded: number } | undefined;
  private next: { path?: string; linkpath?: string; size?: number } = {};
  private readonly symlinks = new Set<string>();
  private ended = false;
  private unpacked = 0;

  constructor(private readonly maxUnpackedBytes: number) {}

  feed(chunk: Uint8Array): void {
    this.unpacked += chunk.length;
    if (this.unpacked > this.maxUnpackedBytes) throw new ArchiveRefused(`the archive unpacks to more than ${this.maxUnpackedBytes} bytes`);
    let data = this.pending.length === 0 ? chunk : concatTwo(this.pending, chunk);
    this.pending = new Uint8Array(0);
    while (data.length > 0 && !this.ended) {
      if (this.collecting !== undefined) {
        const take = Math.min(this.collecting.padded - this.collecting.at, data.length);
        const into = Math.min(take, Math.max(0, this.collecting.bytes.length - this.collecting.at));
        this.collecting.bytes.set(data.subarray(0, into), this.collecting.at);
        this.collecting.at += take;
        data = data.subarray(take);
        if (this.collecting.at === this.collecting.padded) this.finishCollecting();
        continue;
      }
      if (this.skip > 0) {
        const take = Math.min(this.skip, data.length);
        this.skip -= take;
        data = data.subarray(take);
        continue;
      }
      if (data.length < BLOCK) {
        this.pending = data.slice();
        return;
      }
      this.header(data.subarray(0, BLOCK));
      data = data.subarray(BLOCK);
    }
  }

  /** The entries, once the stream ended: refused when it was cut short. */
  end(): TarEntry[] {
    if (!this.ended && (this.skip > 0 || this.collecting !== undefined || this.pending.length > 0)) throw new ArchiveRefused("the archive is truncated");
    if (!this.ended && this.entries.length === 0) throw new ArchiveRefused("the archive has no end-of-archive block");
    return this.entries;
  }

  private header(block: Uint8Array): void {
    if (block.every((byte) => byte === 0)) {
      this.ended = true;
      return;
    }
    if (!checksumOk(block)) throw new ArchiveRefused("a header's checksum is wrong (not a tar archive, or corrupt)");
    const type = String.fromCharCode(block[156] ?? 0);
    const own = octal(block, 124, 12);
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (own > 1024 * 1024) throw new ArchiveRefused("an extended header is larger than 1 MiB");
      const kind = type === "x" ? "pax" : type === "g" ? "global" : type === "L" ? "longname" : "longlink";
      this.collecting = { kind, bytes: new Uint8Array(own), at: 0, padded: Math.ceil(own / BLOCK) * BLOCK };
      if (own === 0) this.finishCollecting();
      return;
    }
    const size = this.next.size ?? own;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const magic = text(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? text(block, 345, 155) : "";
    const name = text(block, 0, 100);
    const raw = this.next.path ?? (prefix === "" ? name : `${prefix}/${name}`);
    const linkTarget = this.next.linkpath ?? text(block, 157, 100);
    this.next = {};
    const path = entryPath(raw);
    const kind = type === "0" || type === "\0" || type === "7" ? "file" : type === "5" ? "directory" : type === "2" ? "symlink" : undefined;
    if (kind === undefined) throw new ArchiveRefused(`${JSON.stringify(path.slice(0, 200))} is ${type === "1" ? "a hard link" : `an entry of type ${JSON.stringify(type)}`}: a snapshot holds regular files, directories and symlinks only`);
    if (path === "" && kind !== "directory") throw new ArchiveRefused("the archive's root is not a directory");
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (this.symlinks.has(segments.slice(0, i).join("/"))) throw new ArchiveRefused(`${JSON.stringify(path.slice(0, 200))} is below a symlink of the archive`);
    }
    if (kind === "symlink") {
      if (!linkStaysInside(path, linkTarget)) throw new ArchiveRefused(`the symlink ${JSON.stringify(path.slice(0, 200))} points outside the workspace (${JSON.stringify(linkTarget.slice(0, 200))})`);
      this.symlinks.add(path);
    }
    this.entries.push({ path, kind, size: kind === "file" ? size : 0, ...(kind === "symlink" && { linkTarget }) });
    this.skip = kind === "file" ? padded : 0;
  }

  private finishCollecting(): void {
    const collected = this.collecting;
    this.collecting = undefined;
    if (collected === undefined) return;
    if (collected.kind === "pax") {
      const records = paxRecords(collected.bytes);
      if (records.path !== undefined) this.next.path = records.path;
      if (records.linkpath !== undefined) this.next.linkpath = records.linkpath;
      if (records.size !== undefined) {
        const size = Number(records.size);
        if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveRefused("a pax size is not a size");
        this.next.size = size;
      }
    } else if (collected.kind === "longname") this.next.path = text(collected.bytes, 0, collected.bytes.length);
    else if (collected.kind === "longlink") this.next.linkpath = text(collected.bytes, 0, collected.bytes.length);
  }
}

function concatTwo(a: Uint8Array, b: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(a.length + b.length);
  bytes.set(a);
  bytes.set(b, a.length);
  return bytes;
}

/**
 * The entries of a gzip'd tar archive, and how many of its bytes are the gzip member (`length`): a tar
 * writing to a pipe may pad its compressed output with zeros to a whole record (bsdtar's 10240 bytes),
 * which some gunzips refuse; the member is then found by trimming them (its own last bytes may be zeros
 * too: ISIZE). `ArchiveRefused` for anything else (bad gzip included).
 */
export async function inspectArchive(gzipped: Uint8Array, maxUnpackedBytes: number): Promise<{ entries: TarEntry[]; length: number }> {
  try {
    return { entries: await inspect(gzipped, maxUnpackedBytes), length: gzipped.length };
  } catch (error) {
    if (!(error instanceof GzipFailed)) throw error;
    if (gzipped.at(-1) !== 0) throw new ArchiveRefused(error.message);
    let end = gzipped.length;
    while (end > 0 && gzipped[end - 1] === 0) end--;
    for (let length = end; length <= Math.min(gzipped.length - 1, end + 8); length++) {
      try {
        return { entries: await inspect(gzipped.subarray(0, length), maxUnpackedBytes), length };
      } catch (again) {
        if (!(again instanceof GzipFailed)) throw again;
      }
    }
    throw new ArchiveRefused(error.message);
  }
}

async function inspect(gzipped: Uint8Array, maxUnpackedBytes: number): Promise<TarEntry[]> {
  const inspector = new TarInspector(maxUnpackedBytes);
  const source = new Blob([gzipped as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      inspector.feed(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ArchiveRefused) throw error;
    throw new GzipFailed(`the archive is not gzip'd tar: ${error instanceof Error ? error.message : String(error)}`);
  }
  return inspector.end();
}

class GzipFailed extends Error {}
