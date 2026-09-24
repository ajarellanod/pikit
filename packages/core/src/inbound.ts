/**
 * The inbound path (SPEC §5): what a channel makes of a platform request, and the pipelines it
 * runs before handing the message to its conversation.
 *
 *   inbound.authenticate   is this request from who it claims to be?        (the channel's stage)
 *   inbound.normalize      the platform's payload as an `InboundMessage`
 *   route.resolve          which agent answers it                          (a router component)
 *
 * The shapes start with what the first channel needs. A field is added, optional, with the
 * component that produces it (threads, attachments, tenants): adding one is compatible, removing
 * one is not.
 */

/** One message from a channel, whatever the platform (SPEC §5). */
export interface InboundMessage {
  /**
   * The message's identity: the platform's delivery id, or the client's own message id. It becomes
   * `AgentRequest.requestId`, so a message delivered twice is the same request.
   */
  id: string;
  /** The channel it came from (`http`, `telegram`): the component's channel name. */
  channel: string;
  /** The platform's conversation: a chat, a thread, an HTTP client's conversation id. */
  conversationId: string;
  /** Who sent it, as the channel's authentication established. */
  actor: { id: string };
  text: string;
  /** The platform's payload, for stages that need more than the fields above. The core never reads it. */
  raw: unknown;
  /** When the channel received it (`clock.now()`). */
  receivedAt: number;
}

/** Which agent answers a message, and whether it may (SPEC §5). */
export interface RouteDecision {
  /** Name of the `agent.definition` that answers. */
  agent: string;
  access: "allow" | "deny";
  /** Why, for a `deny` and for `pikit doctor`. */
  reason?: string;
}

declare module "./pipeline.ts" {
  interface AppPipelines {
    /**
     * Every channel authenticates its requests with a stage here, and acts only on its own
     * (`channel`). A request is authenticated only when a stage says so: no verdict is a rejection.
     */
    "inbound.authenticate": {
      channel: string;
      request: Request;
      verdict?: { kind: "authenticated"; actor: InboundMessage["actor"] } | { kind: "rejected"; reason: string };
    };
    /** The message as the channel built it; stages may rewrite it, and must keep `id` and `channel`. */
    "inbound.normalize": InboundMessage;
    /** A router fills in `decision`; a stage that finds one already there leaves it. */
    "route.resolve": { message: InboundMessage; decision?: RouteDecision };
  }
}
