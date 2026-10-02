/**
 * `conversations.registry`: which runtime conversation a conversation key is in now.
 *
 * A conversation key (`channel:conversationId`, built by the channel) points to one active
 * conversation of the agent runtime (`ConversationRef.conversationId`, created through
 * `agent.conversations`). The pointer is a record, never worker memory: it outlives every worker,
 * and dropping a conversation from memory never touches it. A reset is the only thing that moves it,
 * and it moves it to a new conversation: the old one is kept, and no pointer is ever deleted.
 */

import type { ConversationRef } from "./agent.ts";
import type { AppContext } from "@pikit/core";

export interface ConversationRegistry {
  /**
   * The conversation for `key`. The first time, the registry creates its runtime conversation and
   * records the pointer with `agent`; after that it returns what it recorded. A conversation keeps the
   * agent it was created with: an actor does not change class. Concurrent first calls for one key
   * create one conversation.
   */
  resolve(key: string, agent: string, ctx: AppContext): Promise<ConversationRef>;
  /** The conversation for `key`, or `undefined` if none was ever resolved. Creates nothing. */
  get(key: string, ctx: AppContext): Promise<ConversationRef | undefined>;
  /**
   * Point `key` to a new runtime conversation, keep the previous one, and emit `conversation.reset`
   * once the new pointer is durable. `undefined`, with no event, when `key` has no conversation. A
   * run still going on the previous conversation finishes there.
   */
  reset(key: string, ctx: AppContext): Promise<ConversationReset | undefined>;
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
