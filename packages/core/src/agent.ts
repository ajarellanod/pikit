/**
 * The agent's programming model (SPEC §6.1): the shapes a project and its components use to talk
 * to the agent runtime, without importing Pi.
 *
 * The core owns the shapes; Pi runs the agent. What is Pi-specific inside them (messages, tools,
 * usage) is opaque here and made precise by `@pikit/pi-adapter` through declaration merging on
 * `AgentPayloads`, the same mechanism as `AppEvents`. A project with the adapter sees Pi's exact
 * types; the core never depends on them.
 *
 * `dispatch` returns an admission, not an answer: a run's answer is the `agent.settled` event,
 * which the runtime emits from Pi's `run_end` whether or not anyone is waiting. A run resumed by
 * a new worker after a crash has no caller, so a return value could not carry its answer.
 */

import type { AppContext } from "./app.ts";

/**
 * Pi payload types, filled in by `@pikit/pi-adapter`:
 *
 *   declare module "@pikit/core" {
 *     interface AgentPayloads { message: AgentMessage; tool: AgentHarnessTool; usage: Usage }
 *   }
 *
 * Without the adapter each payload is `unknown`: the core compiles and stays neutral.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface AgentPayloads {}

type Payload<K extends string> = AgentPayloads extends Record<K, infer T> ? T : unknown;

/** One message of a transcript (Pi's `AgentMessage`). */
export type AgentMessage = Payload<"message">;
/** A tool the agent can call (Pi's harness tool). */
export type AgentTool = Payload<"tool">;
/** Token and cost accounting of a run (Pi's `Usage`). */
export type Usage = Payload<"usage">;

/** Which conversation (actor) a message belongs to (SPEC §5, §7). */
export interface ConversationRef {
  /** `tenant:channel:conversationId[:threadId]`. */
  key: string;
  /** Name of the `AgentDefinition` that runs this conversation (`agent.definition` key). */
  agent: string;
  /** The Pi session that holds the conversation's state. A reset points to a new one. */
  sessionId: string;
}

/**
 * What the agent has for one turn: model, instructions and tools. The static fields of an
 * `AgentDefinition` are its defaults; `prepare(state)` will return a partial one (§6.2a).
 */
export interface TurnConfig {
  /** `provider/modelId`, resolved by the runtime against its models. */
  model: string;
  systemPrompt?: string;
  tools: readonly AgentTool[];
}

/**
 * An agent is to a conversation what a class is to an object (SPEC §7.1): routing picks the agent
 * by name, and the runtime finds its definition under the keyed capability `agent.definition`.
 */
export interface AgentDefinition {
  /** kebab-case; the key under which the project provides it and `ConversationRef.agent`. */
  name: string;
  /** `provider/modelId`. */
  model: string;
  systemPrompt?: string;
  tools?: readonly AgentTool[];
}

const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** `provider/modelId`; the model id may contain slashes of its own (`openrouter/anthropic/x`). */
const MODEL = /^[^/\s]+\/\S+$/;

/** Check an agent definition's shape and return it unchanged. */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  if (!AGENT_NAME.test(definition.name)) {
    throw new Error(`agent name "${definition.name}" must be kebab-case (e.g. "support")`);
  }
  if (!MODEL.test(definition.model)) {
    throw new Error(`agent "${definition.name}": model "${definition.model}" must be "provider/modelId"`);
  }
  return definition;
}

/**
 * One inbound message for a conversation. The agent is `conversation.agent`: a resumed run has no
 * request to carry a definition, so the name is the only truth. Images, quoted messages and
 * message prompts are added with the components that produce them.
 */
export interface AgentRequest {
  /** Logical identity of the message (`InboundMessage.id`); the `operationId` of a run it starts. */
  requestId: string;
  conversation: ConversationRef;
  prompt: string;
}

/** What happened to a message, known as soon as it is durable in the conversation's session. */
export type Admission =
  /** The conversation was idle: a run started, identified by this request. */
  | { kind: "started"; requestId: string }
  /** The conversation was busy: the message is in Pi's inbox and the run in progress answers it. */
  | { kind: "queued"; requestId: string }
  /** The conversation already has this request: nothing runs. */
  | { kind: "duplicate"; requestId: string };

/** How one run ended: the payload of `agent.settled` and `agent.failed`. */
export interface AgentResult {
  conversation: ConversationRef;
  /** The request that started the run. */
  requestId: string;
  kind: "completed" | "aborted" | "failed";
  /** The run's final answer, when it produced one. */
  text?: string;
  /** What the run added to the transcript. */
  messages: AgentMessage[];
  usage?: Usage;
  error?: { code: string; message: string };
}

/** The `agent.runtime` capability (SPEC §6.1). */
export interface AgentRuntime {
  /**
   * Hand a message to its conversation. Resolves once the message is durable (the ack point for a
   * channel), not when it is answered. `ctx` bounds this call only: cancelling it never stops a
   * run. Opening a conversation first continues the runs a dead worker left open.
   */
  dispatch(request: AgentRequest, ctx: AppContext): Promise<Admission>;
  /** Stop the conversation's active run now. Cooperative: running tools see their signal. */
  abort(conversation: ConversationRef, ctx: AppContext): Promise<void>;
  /**
   * Wake a conversation with no new message and continue the runs a dead worker left open
   * (crash, eviction, hibernation). Their ends arrive as `agent.settled` / `agent.failed`.
   */
  resume(conversation: ConversationRef, ctx: AppContext): Promise<void>;
}

declare module "./events.ts" {
  interface AppEvents {
    /** Every admission, duplicates included. Emitted by the runtime in the caller's context. */
    "agent.dispatched": { conversation: ConversationRef; admission: Admission };
    /** A run started, or a new worker resumed one. */
    "agent.started": { conversation: ConversationRef; requestId: string; resumed: boolean };
    /** A run ended with an answer or was aborted, whether or not anyone waits for it. */
    "agent.settled": AgentResult & { kind: "completed" | "aborted" };
    /** A run failed. */
    "agent.failed": AgentResult & { kind: "failed" };
  }
}

declare module "./capabilities.ts" {
  interface AppCapabilities {
    "agent.runtime": AgentRuntime;
  }
  interface AppKeyedCapabilities {
    /** One per agent, keyed by its name; provided by the project. */
    "agent.definition": AgentDefinition;
  }
}
