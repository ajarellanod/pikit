/**
 * What a conversation's page knows live (`live.ts` follows `GET /chat/api/conversations/:id/events`
 * into it): `reduce` folds each `ChatEvent` into a `LiveState`. Pure: no React, no request
 * (`scripts/chat.test.ts` reads it).
 *
 * - `busy`: a run goes (`state`).
 * - `partial`: the answer as written so far (the whole text each time). A new one (`""`) or the run's
 *   end leaves the one before in `ended`, shown until the messages read again have it (`read`), so an
 *   answer never blinks out between its last word and its message.
 * - `tools`: the names of the tools running now, in the order they started.
 * - `changes`: bumped at each `message` event and at each reconnection: read the messages again.
 */

// Relative, not `@/`: scripts/chat.test.ts imports this module from outside the page.
import type { ChatEvent } from "./chat-api.ts";

/** An answer that ended, as last seen, and the `changes` it ended at. */
export interface Ended {
  text: string;
  at: number;
}

export interface LiveState {
  connected: boolean;
  /** How many times the stream connected. */
  connections: number;
  busy: boolean;
  partial?: string | undefined;
  tools: string[];
  ended: Ended[];
  changes: number;
}

export const INITIAL: LiveState = { connected: false, connections: 0, busy: false, tools: [], ended: [], changes: 0 };

/** Answers ended kept, at most: older ones are in the messages by now. */
const KEPT_ENDED = 5;

export type Action =
  | { type: "reset" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "event"; event: ChatEvent }
  /** The messages were read, the read having started at `changes`; `texts` are the answers it had. */
  | { type: "read"; changes: number; texts: readonly string[] };

const end = (state: LiveState): Ended[] =>
  state.partial === undefined || state.partial.trim() === "" ? state.ended : [...state.ended, { text: state.partial, at: state.changes }].slice(-KEPT_ENDED);

export function reduce(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "reset":
      return INITIAL;
    case "connected":
      // After a drop, what happened meanwhile is read again.
      return { ...state, connected: true, connections: state.connections + 1, changes: state.connections > 0 ? state.changes + 1 : state.changes };
    case "disconnected":
      return { ...state, connected: false, tools: [] };
    case "read":
      // An answer the messages have is shown by them; one they do not have after a later change never will be (its run failed).
      return { ...state, ended: state.ended.filter((each) => !action.texts.includes(each.text) && each.at >= action.changes) };
    case "event":
      break;
  }
  const event = action.event;
  switch (event.type) {
    case "state":
      return event.busy ? { ...state, busy: true } : { ...state, busy: false, partial: undefined, tools: [], ended: end(state) };
    case "partial":
      return event.text === "" ? { ...state, partial: "", ended: end(state) } : { ...state, partial: event.text };
    case "tool":
      if (event.state === "running") return { ...state, tools: [...state.tools, event.name] };
      {
        const at = state.tools.indexOf(event.name);
        return at === -1 ? state : { ...state, tools: state.tools.filter((_, i) => i !== at) };
      }
    case "message":
      return { ...state, changes: state.changes + 1 };
    default:
      return state;
  }
}

/** The live texts still to show besides `answers` (the answers read): the ended ones, then the one being written. */
export function liveTexts(state: LiveState, answers: readonly string[]): { ended: string[]; partial: string | undefined } {
  const shown = new Set(answers);
  const ended = state.ended.map((each) => each.text).filter((text) => !shown.has(text));
  const partial = state.partial !== undefined && !shown.has(state.partial) ? state.partial : undefined;
  return { ended, partial };
}
