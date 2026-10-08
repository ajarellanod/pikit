/**
 * The inbound path: what a channel makes of a platform request, and the pipelines it
 * runs before handing the message to its conversation.
 *
 *   inbound.normalize      the platform's payload as an `InboundMessage`
 *   route.resolve          which agent answers it                          (a router component)
 *
 * Authentication comes first and is the channel's own: each platform proves a sender its way (a
 * bearer token, a signed webhook, a bot API that only delivers real users), so it is not a shared
 * contract. `channel-http` declares its own pipeline for it.
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

import { type AppContext, Halt } from "@pikit/core";
import type { Admission, AgentRuntime, ConversationRef } from "./agent.ts";
import type { ConversationRegistry } from "./conversations.ts";

/** One message from a channel, whatever the platform. */
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

/** Which agent answers a message, and whether it may. */
export interface RouteDecision {
  /** Name of the `agent.definition` that answers. */
  agent: string;
  access: "allow" | "deny";
  /** Why, for a `deny` and for `pikit doctor`. */
  reason?: string;
}

declare module "@pikit/core" {
  interface AppPipelines {
    /** The message as the channel built it; stages may rewrite it, and must keep `id` and `channel`. */
    "inbound.normalize": InboundMessage;
    /** A router fills in `decision`; a stage that finds one already there leaves it. */
    "route.resolve": { message: InboundMessage; decision?: RouteDecision };
  }
}

/**
 * What happened to one inbound message. A producer handles every kind: a channel tells its
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

/**
 * What `AgentRuntime.dispatch` rejects with when the conversation's agent is no agent now, for good: a
 * code agent a deploy removed, a live agent (`agent.directory`) an operator deleted, or one that cannot
 * run here any more (its model gone). Permanent, unlike a runtime that cannot take messages for a while
 * (a plain error: the platform delivers the message again). `admitInbound` moves the key to a new
 * conversation of the agent routed now, once; a producer never retries it. Told apart by `code`, so a
 * second copy of the contracts still recognizes it.
 */
export class AgentUnavailableError extends Error {
  readonly code = "agent_unavailable";
  /** The agent that is no agent now. */
  readonly agent: string;
  constructor(agent: string, message: string) {
    super(message);
    this.name = "AgentUnavailableError";
    this.agent = agent;
  }
}

/** Whether `error` is an `AgentUnavailableError` (by its `code`). */
export function isAgentUnavailable(error: unknown): error is AgentUnavailableError {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "agent_unavailable";
}

export interface AdmitOptions {
  conversations: ConversationRegistry;
  runtime: AgentRuntime;
  /** The conversation's key. The channel builds it: `telegram:<chat id>`, `http:<id>`. */
  key: string;
  /**
   * Called with the conversation once it resolved, right before `dispatch`: the last moment to start
   * waiting for the run's events (`agent.settled`), which may arrive before `dispatch` returns. Called
   * again, with the new conversation, when the first one's agent is gone (below): a later call replaces
   * what an earlier one started. Whatever it starts, the caller ends when the outcome is not `admitted`
   * or `admitInbound` throws.
   */
  beforeDispatch?(conversation: ConversationRef): void;
}

/**
 * The inbound path after authentication: `inbound.normalize`, `route.resolve`, the
 * conversation, `dispatch`. Resolves once the message is durable (the ack point) or stopped; throws
 * when a stage breaks the path's rules (it changed which message or conversation this is) or when a
 * capability fails, as the channel's own code would.
 *
 * **A conversation whose agent is gone** (`dispatch` rejects with `AgentUnavailableError`: removed by a
 * deploy, a live agent deleted) is permanent, so it never throws: the key moves to a new conversation
 * of the agent routed now (`conversations.reset(key, ctx, agent)`, the old one kept, a warning logged
 * naming both), and the message goes there. When routing names the gone agent itself, the message is
 * `denied` with why: its sender is told once, and the platform is acknowledged.
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

  const dispatch = async (conversation: ConversationRef) => {
    options.beforeDispatch?.(conversation);
    return options.runtime.dispatch({ requestId: normalized.id, conversation, prompt: normalized.text }, ctx);
  };
  const gone = (error: AgentUnavailableError): InboundOutcome => {
    ctx.logger.warn("admitInbound: the message's agent is no agent now, and routing names it: denied", { key: options.key, agent: error.agent });
    return { kind: "denied", message: normalized, reason: `the agent "${error.agent}" is no agent now` };
  };
  let conversation = await options.conversations.resolve(options.key, decision.agent, ctx);
  let admission: Admission;
  try {
    admission = await dispatch(conversation);
  } catch (error) {
    if (!isAgentUnavailable(error)) throw error;
    if (conversation.agent === decision.agent) return gone(error);
    // Moved already (a message before this one did it): the key's conversation now; else a new one.
    const now = await options.conversations.get(options.key, ctx);
    const moved =
      now !== undefined && now.conversationId !== conversation.conversationId ? now : (await options.conversations.reset(options.key, ctx, decision.agent))?.conversation;
    if (moved === undefined) throw error;
    ctx.logger.warn("admitInbound: the conversation's agent is no agent now; its key moves to a new conversation of the agent routed now", {
      key: options.key,
      agent: conversation.agent,
      routed: moved.agent,
      previousConversationId: conversation.conversationId,
      conversationId: moved.conversationId,
    });
    conversation = moved;
    try {
      admission = await dispatch(conversation);
    } catch (again) {
      if (isAgentUnavailable(again)) return gone(again);
      throw again;
    }
  }
  if (admission.kind === "duplicate") return { kind: "duplicate", message: normalized, conversation };
  return { kind: "admitted", message: normalized, conversation, admission };
}

function halted(pipeline: "inbound.normalize" | "route.resolve", halt: Halt): InboundOutcome {
  return { kind: "halted", pipeline, stage: halt.stage ?? "unknown", reason: halt.reason };
}

