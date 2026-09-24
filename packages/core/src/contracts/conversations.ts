/**
 * `conversations.registry` (SPEC §7.4, §7.6): which Pi session a conversation is in now.
 *
 * A conversation key (`channel:conversationId`, built by the channel) points to one active
 * session. The pointer is a record, never worker memory: it outlives every worker, and dropping a
 * conversation from memory never touches it (§7.1, §7.4). A reset is the only thing that moves it,
 * and it moves it to a new session: the old one is kept, and no pointer is ever deleted.
 */

import type { ConversationRef } from "../agent.ts";
import type { AppContext } from "../app.ts";

export interface ConversationRegistry {
  /**
   * The conversation for `key`. The first time, the registry creates its session and records the
   * pointer with `agent`; after that it returns what it recorded. A conversation keeps the agent it
   * was created with: an actor does not change class (§7.1). Concurrent first calls for one key
   * create one session.
   */
  resolve(key: string, agent: string, ctx: AppContext): Promise<ConversationRef>;
  /** The conversation for `key`, or `undefined` if none was ever resolved. Creates nothing. */
  get(key: string, ctx: AppContext): Promise<ConversationRef | undefined>;
  /**
   * Point `key` to a new session, keep the previous one, and emit `conversation.reset` once the
   * new pointer is durable. `undefined`, with no event, when `key` has no conversation. A run still
   * going on the previous session finishes there.
   */
  reset(key: string, ctx: AppContext): Promise<ConversationReset | undefined>;
}

/** What a reset did: the payload of `conversation.reset` (§7.6). */
export interface ConversationReset {
  /** The conversation as it is now, on its new session. */
  conversation: ConversationRef;
  previousSessionId: string;
  newSessionId: string;
}

declare module "../events.ts" {
  interface AppEvents {
    /** A conversation was pointed to a new session; the previous one is kept (§7.6). */
    "conversation.reset": ConversationReset;
  }
}

declare module "../capabilities.ts" {
  interface AppCapabilities {
    "conversations.registry": ConversationRegistry;
  }
}
