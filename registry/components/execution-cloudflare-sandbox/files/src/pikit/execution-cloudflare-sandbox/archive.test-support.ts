/**
 * A tar builder for the tests: gzip'd ustar archives of crafted entries, those no tar program would
 * write included (a path leaving the root, a link outside, a hard link, a FIFO, a bad checksum, a
 * truncated archive). Web APIs only, so the workerd lane uses it too.
 */

/** One entry of a crafted archive. `type`: tar's typeflag ("0" file, "5" directory, "2" symlink, "1" hard link, "6" FIFO, "x" pax header). */
export interface CraftedEntry {
  name: string;
  type?: string;
  content?: string;
  linkname?: string;
  /** Spoil the header's checksum. */
  badChecksum?: boolean;
}

function header(entry: CraftedEntry, size: number): Uint8Array {
  const block = new Uint8Array(512);
  const put = (at: number, text: string) => block.set(new TextEncoder().encode(text), at);
  put(0, entry.name.slice(0, 100));
  put(100, entry.type === "5" ? "0000755\0" : "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, entry.type ?? "0");
  if (entry.linkname !== undefined) put(157, entry.linkname);
  put(257, "ustar\0");
  put(263, "00");
  put(148, "        ");
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${(entry.badChecksum === true ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** A ustar archive of `entries` (two zero blocks at its end unless `truncate`), gzip'd. */
export async function craftArchive(entries: CraftedEntry[], options: { truncate?: boolean } = {}): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.content ?? "");
    blocks.push(header(entry, content.length));
    if (content.length > 0) {
      const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
      padded.set(content);
      blocks.push(options.truncate === true ? padded.subarray(0, Math.max(1, padded.length - 100)) : padded);
    }
  }
  if (options.truncate !== true) blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((size, block) => size + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    tar.set(block, at);
    at += block.length;
  }
  return new Uint8Array(await new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}
