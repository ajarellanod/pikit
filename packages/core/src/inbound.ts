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
 *
 * `admitInbound` runs the path after authentication, the same for every producer of messages (a
 * channel, a scheduler), and returns what happened; the producer decides what that means to its
 * sender. It is the protocol in code, not a strategy: what varies (normalizing, routing, dedup) is a
 * pipeline stage, and what is a platform's (authentication, the conversation key, commands, replies)
 * stays in the channel.
 */

import type { Admission, AgentRuntime, ConversationRef } from "./agent.ts";
import type { AppContext } from "./app.ts";
import type { ConversationRegistry } from "./contracts/conversations.ts";
import { Halt } from "./pipeline.ts";

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

/**
 * What happened to one inbound message (SPEC §5). A producer handles every kind: a channel tells its
 * sender, a scheduler logs. `admitted` and `duplicate` carry the conversation the message is in.
 */
export type InboundOutcome =
  /** Durable in its conversation: a run started, or the run in progress takes it. */
  | { kind: "admitted"; message: InboundMessage; conversation: ConversationRef; admission: Admission & { kind: "started" | "queued" } }
  /** The conversation already has this message (a redelivery): nothing runs. */
  | { kind: "duplicate"; message: InboundMessage; conversation: ConversationRef }
  /** A stage stopped it: `inbound.normalize` (a policy) or `route.resolve` (a router). */
  | { kind: "halted"; pipeline: "inbound.normalize" | "route.resolve"; stage: string; reason: string }
  /** The router decided no agent answers it. */
  | { kind: "denied"; message: InboundMessage; reason?: string }
  /** No stage of `route.resolve` decided: no router is installed. Logged as an error. */
  | { kind: "no_route"; message: InboundMessage };

export interface AdmitOptions {
  conversations: ConversationRegistry;
  runtime: AgentRuntime;
  /** The conversation's key. The channel builds it (SPEC §7.4): `telegram:<chat id>`, `http:<id>`. */
  key: string;
  /**
   * Called with the conversation once it resolved, right before `dispatch`: the last moment to start
   * waiting for the run's events (`agent.settled`), which may arrive before `dispatch` returns.
   * Whatever it starts, the caller ends when the outcome is not `admitted` or `admitInbound` throws.
   */
  beforeDispatch?(conversation: ConversationRef): void;
}

/**
 * The inbound path after authentication (SPEC §5): `inbound.normalize`, `route.resolve`, the
 * conversation, `dispatch`. Resolves once the message is durable (the ack point) or stopped; throws
 * when a stage breaks the path's rules (it changed which message or conversation this is) or when a
 * capability fails, as the channel's own code would.
 */
export async function admitInbound(ctx: AppContext, message: InboundMessage, options: AdmitOptions): Promise<InboundOutcome> {
  const normalized = await ctx.run("inbound.normalize", message);
  if (normalized instanceof Halt) return halted("inbound.normalize", normalized);
  // A stage may rewrite the text or enrich the message; which message and conversation it is stays.
  for (const field of ["id", "channel", "conversationId"] as const) {
    if (normalized[field] !== message[field]) {
      throw new Error(`inbound.normalize: a stage changed the message's ${field} ("${message[field]}" → "${normalized[field]}"); stages keep id, channel and conversationId`);
    }
  }

  const routed = await ctx.run("route.resolve", { message: normalized });
  if (routed instanceof Halt) return halted("route.resolve", routed);
  const decision = routed.decision;
  if (decision === undefined) {
    ctx.logger.error("no route.resolve stage decided: install a router (router-basic)", { channel: message.channel, message: message.id });
    return { kind: "no_route", message: normalized };
  }
  if (decision.access === "deny") return { kind: "denied", message: normalized, ...(decision.reason !== undefined && { reason: decision.reason }) };

  const conversation = await options.conversations.resolve(options.key, decision.agent, ctx);
  options.beforeDispatch?.(conversation);
  const admission = await options.runtime.dispatch({ requestId: normalized.id, conversation, prompt: normalized.text }, ctx);
  if (admission.kind === "duplicate") return { kind: "duplicate", message: normalized, conversation };
  return { kind: "admitted", message: normalized, conversation, admission };
}

function halted(pipeline: "inbound.normalize" | "route.resolve", halt: Halt): InboundOutcome {
  return { kind: "halted", pipeline, stage: halt.stage ?? "unknown", reason: halt.reason };
}

