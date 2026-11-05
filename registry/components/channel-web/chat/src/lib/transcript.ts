/**
 * A conversation's JSON, as whatever serves it gives it (the dashboard's admin API, channel-web's chat
 * API): its transcript's entries (`TranscriptEntry`, newest first, paged) and its live events
 * (`LiveEvent`, `agent.observe`'s `watch` as state); and what its live view knows of them: `reduce`
 * folds each event into a `LiveState`. Pure: no React, no request.
 *
 * The stream sends what the conversation shows live (`Live`) whole first (`["r", value]`), then the
 * ops that change it (`json-ops.ts`), and the newest state again to a client that fell behind: the
 * state is that value with every `live` event's ops applied in order, never a count of events. What is
 * written for good (entries) is read from the transcript again: `changes` counts the times it changed
 * (an `entries`, `usage` or `transcript` event, and a value sent whole: a stream that starts again says
 * nothing of what it missed). Until it is read, `entries` holds the ones the stream announced, as the
 * transcript gives them: they come before the change that ends the answer they hold, so an answer
 * never leaves the thread before its entry is in it.
 */

// Relative, not `@/`: scripts/dashboard.test.ts imports this module from outside the dashboard.
import { applyOps, type JsonOp, type JsonValue } from "./json-ops.ts";
import type { AssistantMessage as Assistant, RunningTool } from "./messages.ts";

/** One entry of a conversation's history: its messages in pi-ai's JSON (admin-api's `ApiTranscriptEntry`). */
export interface TranscriptEntry {
  id: string;
  /** `message`, `pi.reset`, …: the runtime's words. */
  kind: string;
  messages: unknown[];
}

/** One page of a transcript, newest first, and the cursor of the next (absent on the last page). */
export interface TranscriptPage {
  items: TranscriptEntry[];
  next?: string;
}

/** Why the newest run ended without an answer (admin-api's `ApiRunFailure`), until a run starts again. */
export interface RunFailure {
  /** The runtime's word: `model_error`, `no_model`, `aborted`, `reset`, `interrupted`, `turn_limit`, … */
  reason: string;
  /** What the runtime says of it (an error's text), when it says anything. */
  detail?: string;
}

/**
 * One live event of a conversation (admin-api's `ApiEvent`): `live`, the ops over what it shows (the
 * first `[["r", value]]`); `entries` the transcript gained, oldest first; `usage` and `transcript`, read
 * those again.
 */
export type LiveEvent =
  | { type: "live"; ops: readonly JsonOp[] }
  | { type: "entries"; entries: readonly TranscriptEntry[] }
  | { type: "usage" }
  | { type: "transcript" };

export interface LiveState {
  connected: boolean;
  /** What the conversation shows live (admin-api's `ApiLive`), as the ops made it; `undefined` until the first. */
  value: JsonValue | undefined;
  /** Read of `value`: whether a run goes, the answer being written, the tools not done, why the last run gave no answer. */
  busy: boolean;
  partial?: Assistant | undefined;
  tools: RunningTool[];
  failure?: RunFailure | undefined;
  /** The entries the stream announced, oldest first: the transcript's newest, maybe not read yet. */
  entries: TranscriptEntry[];
  /** Bumped whenever the transcript or the cost changed: read them again. */
  changes: number;
}

export const INITIAL: LiveState = { connected: false, value: undefined, busy: false, tools: [], entries: [], changes: 0 };

export type Action = { type: "reset" } | { type: "connected" } | { type: "disconnected" } | { type: "event"; event: LiveEvent };

/** The ones announced, the most recent kept: older ones are in the transcript read since. */
const KEPT_ENTRIES = 50;
const withEntries = (entries: TranscriptEntry[], added: readonly TranscriptEntry[]): TranscriptEntry[] => {
  const known = new Set(entries.map((each) => each.id));
  const fresh: TranscriptEntry[] = [];
  for (const each of added) {
    if (known.has(each.id)) continue;
    known.add(each.id);
    fresh.push(each);
  }
  return fresh.length === 0 ? entries : [...entries, ...fresh].slice(-KEPT_ENTRIES);
};

type Fields = { readonly [key: string]: JsonValue };
const isObject = (value: JsonValue | undefined): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);

/** What `value` (an `ApiLive`) shows: what a part of it that is not as it says is left out of. */
function shown(value: JsonValue): Pick<LiveState, "busy" | "partial" | "tools" | "failure"> {
  const live = isObject(value) ? value : {};
  const partial = live.partial;
  const failure = live.failure;
  const tools = Array.isArray(live.tools) ? (live.tools as readonly JsonValue[]) : [];
  return {
    busy: live.busy === true,
    // The same object while its ops leave it alone (`applyOps`): the thread knows it by identity.
    partial: isObject(partial) && Array.isArray(partial.content) ? (partial as unknown as Assistant) : undefined,
    tools: tools.filter(isObject).flatMap((tool) =>
      tool.status === "done" ? [] : [{ callId: String(tool.callId), name: String(tool.name), output: typeof tool.output === "string" ? tool.output : "" }],
    ),
    failure: isObject(failure) ? { reason: String(failure.reason), ...(typeof failure.detail === "string" && { detail: failure.detail }) } : undefined,
  };
}

export function reduce(state: LiveState, action: Action): LiveState {
  if (action.type === "reset") return INITIAL;
  if (action.type === "connected") return { ...state, connected: true };
  if (action.type === "disconnected") return { ...state, connected: false };
  const event = action.event;
  switch (event.type) {
    case "live": {
      let value: JsonValue;
      try {
        value = applyOps(state.value ?? null, event.ops);
      } catch {
        // Ops that do not apply to what is held: nothing more is applied until the value comes whole again.
        return { ...state, value: undefined };
      }
      // A value sent whole starts a stream (or catches up one that fell behind): what it missed is read again.
      const whole = event.ops.some((op) => op[0] === "r");
      return { ...state, ...shown(value), value, changes: whole ? state.changes + 1 : state.changes };
    }
    case "entries":
      return { ...state, entries: withEntries(state.entries, event.entries), changes: state.changes + 1 };
    case "usage":
    case "transcript":
      return { ...state, changes: state.changes + 1 };
    default:
      return state;
  }
}

const FAILURES: Record<string, string> = {
  model_error: "The model failed",
  no_model: "There was no model to answer with",
  aborted: "The run was stopped",
  reset: "The conversation was reset",
  interrupted: "The App stopped while the model answered",
  faulted: "The run failed",
  orphaned: "The run could not go on",
  restart_limit: "The run was cut off too many times",
  turn_limit: "The tool rounds reached their limit",
  nothing_to_answer: "There was nothing to answer",
};

/** Why the last run gave no answer, said plainly: the runtime's reason, and what it said of it. */
export function failureText(failure: RunFailure): string {
  const said = FAILURES[failure.reason] ?? `It ended: ${failure.reason}`;
  return failure.detail === undefined || failure.detail === "" ? `${said}.` : `${said}: ${failure.detail}`;
}
