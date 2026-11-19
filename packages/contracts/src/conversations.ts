/**
 * `conversations.registry`: which runtime conversation a conversation key is in now.
 *
 * A conversation key (`channel:conversationId`, built by the channel) points to one active
 * conversation of the agent runtime (`ConversationRef.conversationId`, created through
 * `agent.conversations`). The pointer is a record, never worker memory: it outlives every worker,
 * and dropping a conversation from memory never touches it. A reset is the only thing that moves it,
 * and it moves it to a new conversation: the old one is kept, and no pointer is ever deleted.
 *
 * A pointer also records the conversation's channel (`ConversationRef.channel`), given with the key's
 * first resolve: a conversation belongs to one channel for good, so neither a later resolve nor a
 * reset changes it. So are its space (`ConversationRef.space`) and its owner (`ConversationRef.owner`),
 * when the channel gives them.
 */

import type { ConversationRef } from "./agent.ts";
import type { Principal } from "./change.ts";
import type { AppContext } from "@pikit/core";

/** Where a conversation belongs, given with its key's first resolve and kept for good. */
export interface ConversationPlace {
  /** Its channel (`ConversationRef.channel`). */
  channel: string;
  /** Its space (`ConversationRef.space`), when the channel gives one: non-empty. */
  space?: string;
  /**
   * Its owner (`ConversationRef.owner`), when the channel gives one: the person whose conversation it is
   * (channel-web's user, the operator who started a dashboard conversation). A channel and an id, both
   * non-empty; only those two are recorded (a `name` is not: it changes, the owner does not).
   */
  owner?: Principal;
}

export interface ConversationRegistry {
  /**
   * The conversation for `key`. The first time, the registry creates its runtime conversation and
   * records the pointer with `agent` and `place` (its channel, and its space and owner when given); after
   * that it returns what it recorded. A conversation keeps the agent it was created with (an actor does
   * not change class), its channel, its space and its owner: a later call's `agent` and `place` change
   * nothing (an owner given after the first resolve is ignored). Concurrent first calls for one key
   * create one conversation. The ref it returns has the recorded `channel`, and `space` and `owner`
   * (its channel and id) when recorded. An empty `place.space`, or an owner whose channel or id is not
   * non-empty text, is refused (throws, nothing recorded).
   */
  resolve(key: string, agent: string, place: ConversationPlace, ctx: AppContext): Promise<ConversationRef>;
  /** The conversation for `key`, with its `channel` (and `space`, `owner`), or `undefined` if none was ever resolved. Creates nothing. */
  get(key: string, ctx: AppContext): Promise<ConversationRef | undefined>;
  /**
   * Point `key` to a new runtime conversation, keep the previous one, and emit `conversation.reset`
   * once the new pointer is durable. `undefined`, with no event, when `key` has no conversation. A
   * run still going on the previous conversation finishes there. The new conversation keeps the key's
   * agent when `agent` is `undefined`, else the agent it names: what `admitInbound` gives when the key's agent is no agent
   * now (removed), the agent routing chooses now. It keeps the key's channel, space and owner either way.
   */
  reset(key: string, agent: string | undefined, ctx: AppContext): Promise<ConversationReset | undefined>;
}

/** What a reset did: the payload of `conversation.reset`. */
export interface ConversationReset {
  /** The conversation as it is now, on its new runtime conversation. */
  conversation: ConversationRef;
  previousConversationId: string;
  newConversationId: string;
}

declare module "@pikit/core" {
  interface AppEvents {
    /** A conversation key was pointed to a new runtime conversation; the previous one is kept. */
    "conversation.reset": ConversationReset;
  }
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "conversations.registry": ConversationRegistry;
  }
}
