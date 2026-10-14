/**
 * Server-sent events, read from a `fetch` body (no `EventSource`: it cannot send a header, nor stop
 * reading without closing): `SseParser` takes the text as it comes, in any chunks, and gives each
 * event when its blank line arrives. Pure: no DOM, no request (`scripts/chat.test.ts` reads it).
 *
 * As the spec says: lines end with `\n`, `\r\n` or `\r`; `data:` lines join with `\n`; one space after
 * the colon is dropped; a line starting with `:` is a comment (a heartbeat); an event with no data
 * is none. Only `event` and `data` are kept.
 */

export interface SseEvent {
  /** `message` unless the event named itself (`event: error`). */
  event: string;
  data: string;
}

export class SseParser {
  #buffer = "";
  #event = "";
  #data: string[] = [];

  /** The events `chunk` completes, in order. */
  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const events: SseEvent[] = [];
    for (;;) {
      const end = this.#buffer.search(/\r\n|\r|\n/);
      if (end === -1) break;
      // A `\r` last in the buffer may be half of a `\r\n`: wait for the next chunk.
      if (this.#buffer[end] === "\r" && end === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + (this.#buffer.startsWith("\r\n", end) ? 2 : 1));
      const event = this.#line(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  #line(line: string): SseEvent | undefined {
    if (line === "") {
      const event = this.#data.length === 0 ? undefined : { event: this.#event === "" ? "message" : this.#event, data: this.#data.join("\n") };
      this.#event = "";
      this.#data = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data.push(value);
    else if (field === "event") this.#event = value;
    return undefined;
  }
}
