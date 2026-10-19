/**
 * A command's output, as the host keeps it between two reads (`execRead`): entries numbered in
 * arrival order, kept from the last cursor the client acknowledged, so an answer that was lost is read
 * again, and nothing is read twice.
 *
 * With the caller's `window` (pi-durable's `ShellOutputWindow`), output the client was never sent is
 * folded into one skip as soon as what follows it is more than the window (more than `maxBytes`
 * bytes or `maxLines` newlines): the caller would drop it anyway, so it is neither kept nor sent. A
 * read then delivers the skip with all the output after it as one chunk, as `ShellOutputInfo.skipped`
 * requires ("all output after the omission up to its end, more than the window"). Output already sent
 * is never folded: a client that lost an answer gets the same text again.
 *
 * Without a window, every chunk is delivered, and `pendingBytes` grows while nobody reads: the host
 * stops a command past its bound (`MAX_PENDING_BYTES`, in host.ts).
 */

import type { ShellOutputWindow } from "@pikit/pi-adapter/execution";
import type { WireChunk } from "./protocol.ts";

type Stream = WireChunk["stream"];
type Text = { seq: number; kind: "text"; text: string; stream: Stream; bytes: number; newlines: number };
type Skip = { seq: number; kind: "skip"; bytes: number; newlines: number; endsWithNewline: boolean };
type Entry = Text | Skip;

const encoder = new TextEncoder();

function newlinesIn(text: string): number {
  let count = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) count++;
  return count;
}

export interface OutputRead {
  chunks: WireChunk[];
  /** The cursor after what was read: the next read starts there. */
  next: number;
  /** Whether everything after the cursor was read (a large backlog is read in several answers). */
  complete: boolean;
}

export class OutputLog {
  private entries: Entry[] = [];
  /** The number the next entry gets. */
  private nextSeq = 0;
  /** Entries below it were acknowledged (a later read started past them) and are gone. */
  private acked = 0;
  /** Entries below it were in some answer: never folded into a skip. */
  private sent = 0;
  /** UTF-8 bytes of the text held. */
  pendingBytes = 0;

  constructor(private readonly window?: ShellOutputWindow) {}

  /** The cursor every read so far acknowledged: always `valid`. */
  get acknowledged(): number {
    return this.acked;
  }

  /** Whether there is output after `cursor`. */
  hasAfter(cursor: number): boolean {
    return this.nextSeq > cursor;
  }

  /** Whether `cursor` can be read from: not before what was acknowledged, not past what exists. */
  valid(cursor: number): boolean {
    return cursor >= this.acked && cursor <= this.nextSeq;
  }

  append(text: string, stream: Stream): void {
    if (text === "") return;
    const bytes = encoder.encode(text).length;
    this.entries.push({ seq: this.nextSeq++, kind: "text", text, stream, bytes, newlines: newlinesIn(text) });
    this.pendingBytes += bytes;
    this.fold();
  }

  /**
   * Reads what follows `cursor` (`valid`), acknowledging everything before it, up to about
   * `maxBytes` of text (at least one entry).
   */
  read(cursor: number, maxBytes: number): OutputRead {
    this.acknowledge(cursor);
    const after = this.entries;
    const firstSkip = after.findIndex((entry) => entry.kind === "skip");
    const plain = firstSkip === -1 ? after : after.slice(0, firstSkip);
    const chunks: WireChunk[] = [];
    let bytes = 0;
    let last = cursor - 1;
    for (const entry of plain as Text[]) {
      if (chunks.length > 0 && bytes + entry.bytes > maxBytes) return this.answer(chunks, last + 1, false);
      chunks.push({ text: entry.text, stream: entry.stream });
      bytes += entry.bytes;
      last = entry.seq;
    }
    if (firstSkip !== -1) {
      // Every skip and what lies between them is one omission (two skips meet only when an answer
      // was lost); everything after the last skip, more than the window, is the chunk after it.
      let lastSkip = firstSkip;
      for (let i = firstSkip; i < after.length; i++) if (after[i]?.kind === "skip") lastSkip = i;
      const skipped = { bytes: 0, newlines: 0, endsWithNewline: false };
      for (const entry of after.slice(firstSkip, lastSkip + 1)) {
        skipped.bytes += entry.bytes;
        skipped.newlines += entry.newlines;
        skipped.endsWithNewline = entry.kind === "skip" ? entry.endsWithNewline : entry.text.endsWith("\n");
      }
      const rest = after.slice(lastSkip + 1) as Text[];
      const tail = rest.at(-1);
      if (tail !== undefined) {
        chunks.push({ text: rest.map((entry) => entry.text).join(""), stream: tail.stream, skipped });
        last = tail.seq;
      }
    }
    return this.answer(chunks, last + 1, true);
  }

  private answer(chunks: WireChunk[], next: number, complete: boolean): OutputRead {
    this.sent = Math.max(this.sent, next);
    return { chunks, next, complete };
  }

  private acknowledge(cursor: number): void {
    this.acked = Math.max(this.acked, cursor);
    let drop = 0;
    while (drop < this.entries.length && (this.entries[drop] as Entry).seq < this.acked) {
      const entry = this.entries[drop] as Entry;
      if (entry.kind === "text") this.pendingBytes -= entry.bytes;
      drop++;
    }
    if (drop > 0) this.entries.splice(0, drop);
  }

  /**
   * Folds the first text never sent into the skip before it while the text after it is still more
   * than the window. What was never sent is `[skip] text…`: one skip at most, at its start.
   */
  private fold(): void {
    const window = this.window;
    if (window === undefined) return;
    let start = this.entries.findIndex((entry) => entry.seq >= this.sent);
    if (start === -1) return;
    let restBytes = 0;
    let restNewlines = 0;
    for (let i = start; i < this.entries.length; i++) {
      const entry = this.entries[i] as Entry;
      if (entry.kind === "text") {
        restBytes += entry.bytes;
        restNewlines += entry.newlines;
      }
    }
    for (;;) {
      const head = this.entries[start] as Entry;
      const skip = head.kind === "skip" ? head : undefined;
      const firstText = this.entries[skip === undefined ? start : start + 1];
      if (firstText === undefined || firstText.kind !== "text") return;
      const bytesAfter = restBytes - firstText.bytes;
      const newlinesAfter = restNewlines - firstText.newlines;
      // Only when something more than the window stays after it.
      if (!(bytesAfter > window.maxBytes || newlinesAfter > window.maxLines)) return;
      if (this.entries.length - start - (skip === undefined ? 0 : 1) < 2) return;
      const folded: Skip = skip ?? { seq: firstText.seq, kind: "skip", bytes: 0, newlines: 0, endsWithNewline: false };
      folded.bytes += firstText.bytes;
      folded.newlines += firstText.newlines;
      folded.endsWithNewline = firstText.text.endsWith("\n");
      this.pendingBytes -= firstText.bytes;
      if (skip === undefined) this.entries.splice(start, 1, folded);
      else this.entries.splice(start + 1, 1);
      restBytes = bytesAfter;
      restNewlines = newlinesAfter;
      start = this.entries.indexOf(folded);
    }
  }
}
