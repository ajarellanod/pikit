/**
 * A small ustar/pax writer for the tests: archives as another backend would write them, and the ones
 * an attacker would (absolute names, `..`, links out, hard links, devices), gzip'd.
 */

const encoder = new TextEncoder();

export interface TarEntry {
  name: string;
  /** `0` file, `5` directory, `2` symbolic link, `1` hard link, `3` device, `6` FIFO, `x` pax, `g` global pax, `L` GNU long name. */
  type?: string;
  content?: string | Uint8Array;
  linkname?: string;
  /** Pax records put in an `x` header before this entry. */
  pax?: Record<string, string>;
  /** Breaks the header's checksum. */
  badChecksum?: boolean;
}

function header(entry: { name: string; type: string; size: number; linkname?: string }, badChecksum = false): Uint8Array {
  const block = new Uint8Array(512);
  const put = (at: number, text: string, length: number) => block.set(encoder.encode(text).subarray(0, length), at);
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0";
  put(0, entry.name, 100);
  put(100, octal(entry.type === "5" ? 0o755 : 0o644, 8), 8);
  put(108, octal(0, 8), 8);
  put(116, octal(0, 8), 8);
  put(124, octal(entry.size, 12), 12);
  put(136, octal(1_700_000_000, 12), 12);
  put(148, "        ", 8);
  put(156, entry.type, 1);
  put(157, entry.linkname ?? "", 100);
  put(257, "ustar\0", 6);
  put(263, "00", 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  if (badChecksum) sum += 1;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return block;
}

const padded = (bytes: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
};

function paxData(records: Record<string, string>): Uint8Array {
  let text = "";
  for (const [key, value] of Object.entries(records)) {
    const body = ` ${key}=${value}\n`;
    let length = encoder.encode(body).length + 1;
    while (`${length}`.length + encoder.encode(body).length !== length) length++;
    text += `${length}${body}`;
  }
  return encoder.encode(text);
}

/** The tar of `entries` (ending with two zero blocks), gzip'd unless `gzip` is false. */
export function tarGz(entries: TarEntry[], gzip = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "0";
    if (type === "g") {
      const records = paxData(entry.pax ?? {});
      parts.push(header({ name: "GlobalHead", type: "g", size: records.length }), padded(records));
      continue;
    }
    if (entry.pax !== undefined) {
      const records = paxData(entry.pax);
      parts.push(header({ name: "PaxHeader", type: "x", size: records.length }), padded(records));
    }
    const data = typeof entry.content === "string" ? encoder.encode(entry.content) : (entry.content ?? new Uint8Array(0));
    parts.push(header({ name: entry.name, type, size: data.length, ...(entry.linkname !== undefined && { linkname: entry.linkname }) }, entry.badChecksum), padded(data));
  }
  parts.push(new Uint8Array(1024));
  const size = parts.reduce((n, part) => n + part.length, 0);
  const tar = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    tar.set(part, at);
    at += part.length;
  }
  return gzip ? Bun.gzipSync(tar) : tar;
}
