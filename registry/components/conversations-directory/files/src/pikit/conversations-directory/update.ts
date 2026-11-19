/**
 * What a conversation's App tells the directory (`conversations-directory.seen`): one `Update` per
 * conversation, made by the recorder from the runtime's events (`recorder.ts`) and merged in the
 * conversation's `_outbox` until a flush sends it. Field-wise idempotent where the directory applies it
 * (`directory.ts`): a late or repeated update changes nothing.
 *
 * - `seq`: per conversation, increasing in its App (`nextSeq`): the newest one wins for `busy` and `agent`.
 * - `place`: where it belongs (the key's registry record), applied only the first time (first wins).
 * - `current: false`: a reset left it behind; never goes back to true.
 * - `activity`: each message admitted and each run's end, by an id (`m:<request>`, `r:<request>`), so a
 *   repeat adds nothing; `shown` is whether people see it (never an operator's, `isDashboardRequest`).
 * - `touched`: activity time with no activity of its own (the start's backfill, from `agent.observe`).
 * - `title`: a model's (or a first message's) title, by its precedence (`titleApplies`), the newer one of
 *   an equal source winning.
 */

import { DirectoryError, type Principal, TITLE_MAX } from "@pikit/contracts";
import { ACTIVITY_KEPT } from "./tables.ts";

export type Activity = { id: string; at: number; by: string; shown: boolean };

export type Place = { agent: string; channel: string; space?: string; owner?: Principal; delegated: boolean; current: boolean; at: number };

export type Update = {
  key: string;
  conversationId: string;
  seq: number;
  place?: Place;
  agent?: string;
  busy?: boolean;
  current?: false;
  activity?: Activity[];
  touched?: number;
  title?: { text: string; source: "first" | "model"; at: number };
};

/** The most updates one `seen` carries. */
export const SEEN_MAX = 100;
const PART_MAX = 1024;

/** A seq that grows in this App's life and past it (the clock in microseconds), for every update it makes. */
export function sequencer(now: () => number): () => number {
  let last = 0;
  return () => {
    last = Math.max(last + 1, Math.floor(now()) * 1000);
    return last;
  };
}

/** `b` applied after `a`, both of one conversation: what one outbox row holds. */
export function mergeUpdate(a: Update, b: Update): Update {
  const newer = b.seq >= a.seq ? b : a;
  const older = newer === b ? a : b;
  const merged: Update = { key: a.key, conversationId: a.conversationId, seq: Math.max(a.seq, b.seq) };
  const place = a.place ?? b.place;
  if (place !== undefined) merged.place = place;
  const agent = newer.agent ?? older.agent;
  if (agent !== undefined) merged.agent = agent;
  const busy = newer.busy ?? older.busy;
  if (busy !== undefined) merged.busy = busy;
  if (a.current === false || b.current === false) merged.current = false;
  const activity = [...(a.activity ?? []), ...(b.activity ?? [])];
  if (activity.length > 0) {
    const byId = new Map(activity.map((each) => [each.id, each]));
    merged.activity = [...byId.values()].sort((x, y) => x.at - y.at).slice(-ACTIVITY_KEPT);
  }
  const touched = Math.max(a.touched ?? 0, b.touched ?? 0);
  if (touched > 0) merged.touched = touched;
  const titles = [a.title, b.title].filter((each) => each !== undefined);
  if (titles.length > 0) merged.title = titles.reduce((x, y) => (y.source === "model" && x.source === "first") || (y.source === x.source && y.at >= x.at) ? y : x);
  return merged;
}

type Fields = Record<string, unknown>;
const isObject = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const bad = (what: string): never => {
  throw new DirectoryError("invalid", `conversations-directory: ${what}`);
};
const text = (value: unknown, what: string): string => (typeof value === "string" && value !== "" && value.length <= PART_MAX ? value : bad(`${what} is a non-empty string`));
const time = (value: unknown, what: string): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad(`${what} is a time`));

function placeOf(value: unknown): Place {
  if (!isObject(value)) return bad("place is an object");
  const place: Place = { agent: text(value.agent, "place.agent"), channel: text(value.channel, "place.channel"), delegated: value.delegated === true, current: value.current !== false, at: time(value.at, "place.at") };
  if (value.space !== undefined) place.space = text(value.space, "place.space");
  if (value.owner !== undefined) {
    if (!isObject(value.owner)) return bad("place.owner is a principal");
    place.owner = { channel: text(value.owner.channel, "place.owner.channel"), id: text(value.owner.id, "place.owner.id") };
  }
  return place;
}

/** An update as it arrived (JSON), checked and copied. Throws `DirectoryError` `invalid`. */
export function parseUpdate(value: unknown): Update {
  if (!isObject(value)) return bad("an update is an object");
  const update: Update = { key: text(value.key, "key"), conversationId: text(value.conversationId, "conversationId"), seq: time(value.seq, "seq") };
  if (value.place !== undefined) update.place = placeOf(value.place);
  if (value.agent !== undefined) update.agent = text(value.agent, "agent");
  if (value.busy !== undefined) update.busy = value.busy === true;
  if (value.current === false) update.current = false;
  if (value.activity !== undefined) {
    if (!Array.isArray(value.activity) || value.activity.length > ACTIVITY_KEPT) return bad(`activity is a list of at most ${ACTIVITY_KEPT}`);
    update.activity = value.activity.map((each: unknown) => {
      if (!isObject(each)) return bad("an activity is an object");
      return { id: text(each.id, "activity.id"), at: time(each.at, "activity.at"), by: text(each.by, "activity.by"), shown: each.shown === true };
    });
  }
  if (value.touched !== undefined) update.touched = time(value.touched, "touched");
  if (value.title !== undefined) {
    const title = value.title;
    if (!isObject(title) || (title.source !== "first" && title.source !== "model") || typeof title.text !== "string" || title.text.length > TITLE_MAX * 4) return bad("title is { text, source }");
    update.title = { text: title.text, source: title.source, at: time(title.at, "title.at") };
  }
  return update;
}

/** The updates of a `seen` message. */
export function parseSeen(message: unknown): Update[] {
  const updates = isObject(message) ? message.updates : undefined;
  if (!Array.isArray(updates) || updates.length > SEEN_MAX) return bad(`updates is a list of at most ${SEEN_MAX}`);
  return updates.map(parseUpdate);
}
