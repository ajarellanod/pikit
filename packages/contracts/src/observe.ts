/**
 * `agent.observe`: what the agent runtime holds, read-only, for a reader its consumer authorized for
 * that conversation (the dashboard's operator, SPEC §5; a channel's user for their own conversation).
 * The runtime provides it (runtime-pi, from pi-durable's records), so it is the truth of what the
 * runtime holds, never a copy kept on the side.
 *
 * - **`conversations`** lists the runtime's conversations in the order it keeps them (runtime-pi:
 *   creation order, oldest first; pi-durable has no other, docs/upstream proposal 17), a page at a time: each with
 *   its key and agent (once a message reached it), whether a run is going, when it last changed and
 *   what it cost. A conversation a reset left behind is listed too, under the same key: the registry
 *   (`conversations.registry`) says which one a key is in now.
 * - **`transcript`** is one conversation's history, newest first, a page at a time: each entry with the
 *   messages it holds, in the runtime's own JSON (pi-ai's messages for runtime-pi).
 * - **`watch`** follows one conversation live: its first event is a `snapshot` of what it is now, then
 *   one event per change (a run starts, text streams, a tool runs, the run ends), in the runtime's own
 *   JSON, each with a `type`. It ends when `ctx` is cancelled (a client went away) or the runtime closes.
 *   Events can be missed (SPEC K3): a consumer that falls behind is sent a new `snapshot`, and a new
 *   `watch` starts with one, so a view is always rebuilt from a snapshot, never from a count of events.
 * - **`usage`** is one conversation's spend, every model call and tool summed.
 *
 * **Who reads it is the consumer's to authorize, per conversation**: an operator through
 * `admin.auth` (admin-api: every conversation), or a user of a channel for their own conversation
 * only (channel-web: the key built from the session's user). A consumer that shows it to someone who
 * is not an operator projects what that person may see (channel-web's live view: the answer's text
 * and the tools' names while their message waits; never thinking, tool arguments or results, system
 * prompts or an operator's messages). A transcript holds what people wrote: logs never carry it.
 * Nothing here changes anything: actions (abort, reset) go through the contracts that own them
 * (`agent.runtime`, `conversations.registry`).
 *
 * Where it runs: in the App that runs the runtime. On a server that is the one App and every
 * conversation; on Cloudflare it is each conversation's Durable Object, which sees only its own
 * conversations (features/cloudflare-conversation-index.md).
 */

import type { AppContext } from "@pikit/core";
import type { Usage } from "./agent.ts";
import type { JsonValue } from "./json.ts";
import type { Page, PageRequest } from "./page.ts";

/** One conversation of the runtime, as an operator lists it. */
export interface ObservedConversation {
  /** The runtime's id (`ConversationRef.conversationId`). */
  conversationId: string;
  /** Its conversation key and agent, once a message reached it; absent before. */
  key?: string;
  agent?: string;
  /** Whether a run is going now. */
  busy: boolean;
  /** Epoch ms of its newest message, when it has one. */
  lastActivity?: number;
  /** What it cost so far: every model call and tool of every run. */
  usage: Usage;
}

/** One entry of a conversation's history. */
export interface TranscriptEntry {
  /** The runtime's id of the entry, unique in the conversation. */
  id: string;
  /** What the entry is, in the runtime's words (pi-durable: `message`, `pi.reset`, …). */
  kind: string;
  /** The messages it holds, in the runtime's JSON (pi-ai's `Message` for runtime-pi); none for bookkeeping. */
  messages: JsonValue[];
}

/** One live event of a conversation: JSON, with its `type` (`snapshot` first). */
export type ObservedEvent = { readonly type: string; readonly [key: string]: JsonValue };

export interface AgentObserver {
  conversations(page: PageRequest, ctx: AppContext): Promise<Page<ObservedConversation>>;
  /** `undefined` when the runtime has no such conversation. */
  conversation(conversationId: string, ctx: AppContext): Promise<ObservedConversation | undefined>;
  /** Newest first. `undefined` when the runtime has no such conversation. */
  transcript(conversationId: string, page: PageRequest, ctx: AppContext): Promise<Page<TranscriptEntry> | undefined>;
  /**
   * The conversation live: a `snapshot`, then its changes, until `ctx` is cancelled or the runtime
   * closes. Rejects when the runtime has no such conversation. Stopping early (`break` in a
   * `for await`) releases it.
   */
  watch(conversationId: string, ctx: AppContext): AsyncIterable<ObservedEvent>;
  /** `undefined` when the runtime has no such conversation. */
  usage(conversationId: string, ctx: AppContext): Promise<Usage | undefined>;
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "agent.observe": AgentObserver;
  }
}
