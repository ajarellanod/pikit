/**
 * What a conversation's page knows live (`live.ts` follows `GET /chat/api/conversations/:id/events`
 * into it): `reduce` folds each `ChatEvent` into a `LiveState`. Pure: no React, no request
 * (`scripts/chat.test.ts` reads it).
 *
 * - `busy`: a run goes (`state`).
 * - `partial`: the answer as written so far (the whole text each time), and `requests`, the request ids
 *   of the messages its run answers (when the server knows them). A new one (`""`) or the run's end
 *   leaves the one before in `ended`, shown until the messages read have the stored answer that
 *   replaces it, so an answer never blinks out between its last word and its message.
 * - Which stored answer replaces it is known by identity, never by text: the `message` event of an
 *   answer names the request it answers (`answers`), one of the run's `requests`. An ended text whose
 *   run's requests are not known takes the first answer stored after it ended (answers are delivered in
 *   their runs' order). One whose run failed or was stopped (one of its requests, else the newest
 *   message, read `failed` or `aborted`) goes: no answer comes.
 * - `tools`: the names of the tools running now, in the order they started.
 * - `changes`: bumped at each `message` event and at each reconnection: read the messages again.
 */

// Relative, not `@/`: scripts/chat.test.ts imports this module from outside the page.
import type { ChatEvent, ChatMessage } from "./chat-api.ts";

/** An answer that ended, as last seen. */
export interface Ended {
  text: string;
  /** The request ids its run answers, when the server said them. */
  requests?: readonly string[];
  /** The id of the stored answer that replaces it, once its `message` event came. */
  answer?: string;
}

export interface LiveState {
  connected: boolean;
  /** How many times the stream connected. */
  connections: number;
  busy: boolean;
  partial?: string | undefined;
  /** The request ids of the run whose answer `partial` is, when known. */
  requests?: readonly string[] | undefined;
  tools: string[];
  ended: Ended[];
  changes: number;
}

export const INITIAL: LiveState = { connected: false, connections: 0, busy: false, tools: [], ended: [], changes: 0 };

/** Answers ended kept, at most: older ones are in the messages by now. */
const KEPT_ENDED = 5;

/** What a read of the messages says: their ids, roles and states, newest first (as the API gives them). */
export type ReadMessage = Pick<ChatMessage, "id" | "role" | "state">;

export type Action =
  | { type: "reset" }
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "event"; event: ChatEvent }
  /** The messages were read. */
  | { type: "read"; messages: readonly ReadMessage[] };

const end = (state: LiveState, answer?: string): Ended[] =>
  state.partial === undefined || state.partial.trim() === ""
    ? state.ended
    : [...state.ended, { text: state.partial, ...(state.requests !== undefined && { requests: state.requests }), ...(answer !== undefined && { answer }) }].slice(-KEPT_ENDED);

const stopped = (message: ReadMessage | undefined): boolean => message?.role === "user" && (message.state === "failed" || message.state === "aborted");

export function reduce(state: LiveState, action: Action): LiveState {
  switch (action.type) {
    case "reset":
      return INITIAL;
    case "connected":
      // After a drop, what happened meanwhile is read again.
      return { ...state, connected: true, connections: state.connections + 1, changes: state.connections > 0 ? state.changes + 1 : state.changes };
    case "disconnected":
      return { ...state, connected: false, tools: [] };
    case "read": {
      // An ended answer goes once the read has the stored answer that replaces it, or its run failed.
      const ids = new Set(action.messages.map((message) => message.id));
      const byId = new Map(action.messages.map((message) => [message.id, message]));
      const newestUser = action.messages.find((message) => message.role === "user");
      const ended = state.ended.filter((each) => {
        if (each.answer !== undefined && ids.has(each.answer)) return false;
        if (each.answer !== undefined) return true;
        return each.requests === undefined ? !stopped(newestUser) : !each.requests.some((request) => stopped(byId.get(request)));
      });
      return ended.length === state.ended.length ? state : { ...state, ended };
    }
    case "event":
      break;
  }
  const event = action.event;
  switch (event.type) {
    case "state":
      return event.busy ? { ...state, busy: true } : { ...state, busy: false, partial: undefined, requests: undefined, tools: [], ended: end(state) };
    case "partial": {
      const requests = event.requests ?? state.requests;
      return event.text === "" ? { ...state, partial: "", requests, ended: end(state) } : { ...state, partial: event.text, requests };
    }
    case "tool":
      if (event.state === "running") return { ...state, tools: [...state.tools, event.name] };
      {
        const at = state.tools.indexOf(event.name);
        return at === -1 ? state : { ...state, tools: state.tools.filter((_, i) => i !== at) };
      }
    case "message": {
      const changes = state.changes + 1;
      const answers = event.answers;
      if (answers === undefined) return { ...state, changes };
      // The run's live texts, ended or still shown, are the answer's.
      const claims = (requests: readonly string[] | undefined): boolean => requests === undefined || requests.includes(answers);
      const ended = state.ended.map((each) => (each.answer === undefined && claims(each.requests) ? { ...each, answer: event.id } : each));
      if (state.partial !== undefined && state.requests?.includes(answers) === true) return { ...state, changes, partial: undefined, requests: undefined, ended: end({ ...state, ended }, event.id) };
      return { ...state, changes, ended };
    }
    default:
      return state;
  }
}

/** The live texts still to show besides the messages read (`ids`): the ended ones, then the one being written. */
export function liveTexts(state: LiveState, ids: readonly string[]): { ended: string[]; partial: string | undefined } {
  const shown = new Set(ids);
  const ended = state.ended.filter((each) => each.answer === undefined || !shown.has(each.answer)).map((each) => each.text);
  return { ended, partial: state.partial };
}
