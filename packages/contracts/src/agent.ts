/**
 * The agent's programming model: the shapes a project and its components use to talk
 * to the agent runtime, without importing Pi.
 *
 * The core owns the shapes; Pi runs the agent. What is Pi-specific inside them (messages, tools,
 * usage) is opaque here and made precise by `@pikit/pi-adapter` through declaration merging on
 * `AgentPayloads`, the same mechanism as `AppEvents`. A project with the adapter sees Pi's exact
 * types; the core never depends on them.
 *
 * `dispatch` returns an admission, not an answer: a run's answer is the `agent.settled` event,
 * which the runtime emits when the run ends whether or not anyone is waiting. A run resumed by
 * a new worker after a crash has no caller, so a return value could not carry its answer.
 *
 * What an agent does besides its model, prompt and tools (a system prompt section that recalls,
 * a hook that checks a tool call or rewrites a model request, a durable task) is an agent
 * extension: Pi's own (`defineExtension`), provided by a component under `agent.extension` and
 * named by the agents that run with it (`AgentDefinition.extensions`). What it knows how to do, as
 * instructions it loads when a task needs them, is its skills (`AgentDefinition.skills`, `skill.ts`).
 */

import type { AppContext } from "@pikit/core";
import { isJsonObject } from "./json.ts";
import type { MessagePart } from "./parts.ts";
import { type AgentSkill, isSkillName, skillProblem } from "./skill.ts";

/**
 * Pi payload types, filled in by `@pikit/pi-adapter`:
 *
 *   declare module "@pikit/contracts" {
 *     interface AgentPayloads { message: Message; tool: ToolRegistration; usage: Usage }
 *   }
 *
 * Without the adapter each payload is `unknown`: the contracts compile and stay neutral.
 */
// biome-ignore lint/suspicious/noEmptyInterface: extended by declaration merging
export interface AgentPayloads {}

type Payload<K extends string> = AgentPayloads extends Record<K, infer T> ? T : unknown;

/** One message of a transcript (pi-ai's `Message`). */
export type AgentMessage = Payload<"message">;
/** A tool the agent can call (pi-durable's `ToolRegistration`). */
export type AgentTool = Payload<"tool">;
/** Token and cost accounting of a run (Pi's `Usage`). */
export type Usage = Payload<"usage">;

/** Which conversation (actor) a message belongs to. */
export interface ConversationRef {
  /**
   * The conversation's address, opaque to all but the channel that made it. The channel builds it
   * (`AdmitOptions.key`: `telegram:12345`, `telegram:ops:12345`, `http:<id>`) and is the only one that
   * parses it back, to find where an answer goes; everyone else only stores, compares and logs it. It
   * has no grammar of its own: no tenant or thread part (features/conversation-routing.md).
   */
  key: string;
  /** Name of the `AgentDefinition` that runs this conversation (`agent.definition` key). */
  agent: string;
  /**
   * The runtime's conversation that holds the transcript and the state (a pi-durable conversation id),
   * opaque to everyone but the runtime. A reset points the key to a new one.
   */
  conversationId: string;
  /**
   * The channel the conversation belongs to: the `InboundMessage.channel` of the message that created
   * it (`telegram`, `http`), `dashboard` for one the dashboard started, `delegate` for an agent's task.
   * A conversation belongs to one channel for good (features/conversation-routing.md):
   * `conversations.registry` records it with the key's first resolve, keeps it through resets and
   * gives it with every ref; the runtime records it with the conversation, so a run sees it
   * (`CONVERSATION`, `PrepareContext`, the `workspace` it asks for) whatever ref reached it. It is for
   * a component that treats a channel's conversations apart (a directory, a prompt of their own), never
   * for finding where an answer goes: that stays the key's channel's. Settlements (`AgentResult`,
   * `agent.submissions`) do not carry it. Absent: a ref made by hand for a conversation with none
   * recorded (a test).
   */
  channel?: string;
  /**
   * Where a delegated conversation comes from: the conversation a person or a channel opened, from
   * which its tree of delegations descends (a task delegated from a delegated task has the origin of
   * the one that delegated it). Absent in a conversation that is not delegated: it is its own origin.
   * Read it with `originOf`, never `ref.origin ?? ref` by hand.
   *
   * The runtime fixes it when it creates the delegated conversation, from the delegating one's record,
   * and records it with the conversation for good, as the channel: a run sees it (`CONVERSATION`,
   * `PrepareContext`, the `workspace` it asks for), also after a restart. It never comes from a ref
   * given to the runtime (`dispatch` ignores one's) nor from the model. It is for code that acts for
   * the person behind a delegated task: whose memory, where a scheduled prompt or an approval belongs.
   * Not carried by `agent.submissions` (its settlements and `answers`) nor by `agent.observe`.
   */
  origin?: ConversationOrigin;
}

/** A conversation's origin (`ConversationRef.origin`): a ref with no origin of its own. */
export type ConversationOrigin = Omit<ConversationRef, "origin">;

/**
 * The conversation `ref` descends from: its `origin` when it is delegated, else `ref` itself, either
 * way without an `origin` field (`key`, `agent`, `conversationId`, and `channel` when known).
 */
export function originOf(ref: ConversationRef): ConversationOrigin {
  const { origin, ...own } = ref;
  return origin ?? own;
}

/**
 * What the agent has for one run: model, instructions, tools and extensions. The static fields of an
 * `AgentDefinition` are its defaults; `prepare(state)` returns the fields it changes.
 */
export interface TurnConfig {
  /** `provider/modelId`, resolved by the runtime against its models. */
  model: string;
  systemPrompt?: string;
  /** As in `AgentDefinition.tools`: names of installed tools, or tool objects. */
  tools: readonly (AgentTool | string)[];
  /** As in `AgentDefinition.extensions`: names of installed agent extensions. */
  extensions: readonly string[];
  /** As in `AgentDefinition.skills`: names of installed skills, or skill objects. */
  skills: readonly (AgentSkill | string)[];
}

/**
 * What `prepare` returns: the fields of `TurnConfig` it changes for this run. A field that is absent
 * or `undefined` keeps the agent's static default, so `{ model: late ? "x/y" : undefined }` works.
 */
type TurnChanges = { [K in keyof TurnConfig]?: TurnConfig[K] | undefined };

/** What `prepare` knows besides the state. Fields are added with the features that need them. */
export interface PrepareContext {
  /** The conversation the run belongs to, with its `channel` when one is recorded and its `origin` when it is delegated. */
  conversation: ConversationRef;
}

/**
 * An agent is to a conversation what a class is to an object: routing picks the agent
 * by name, and the runtime finds its definition under the keyed capability `agent.definition`.
 *
 * `S` is the type of the agent's state. It defaults to `object` so that a definition with a typed
 * state is still an `AgentDefinition` wherever one is expected (the `agent.definition` capability).
 */
export interface AgentDefinition<S extends object = object> {
  /** kebab-case; the key under which the project provides it and `ConversationRef.agent`. */
  name: string;
  /** `provider/modelId`. */
  model: string;
  /**
   * Whether it is the project's steward (SPEC §6): its main agent, the only one that knows what the
   * project is made of (the `pikit-self` extension) and may be asked, by its operators, to change it.
   * At most one agent of an App is: the runtime refuses to start with two (`stewardProblem`, which the
   * `agent.runtime` suite checks), and extension-pikit-self
   * refuses an agent that names `pikit-self` and is not the steward. Absent: `false`.
   */
  steward?: boolean;
  systemPrompt?: string;
  /**
   * The agent's tools, and only these. A string names a tool that a `tool-*` component provides
   * under the keyed capability `agent.tool` (`"read"`, `"bash"`); an object is a tool of the
   * project's own. Installing a tool component gives no agent anything until it names the tool, so
   * what an agent can do is written where the agent is defined. The runtime refuses to start when a
   * name has no provider.
   */
  tools?: readonly (AgentTool | string)[];
  /**
   * The agent extensions it runs with, by name, in order: each one a Pi extension that a component
   * provides under the keyed capability `agent.extension` (system prompt sections, which may be
   * async and read the conversation's documents; hooks on model requests, tool calls and
   * compaction; tool wrappers; durable tasks; and tools, which the agent gets with the extension).
   * As with `tools`, only an agent that names an extension runs with it, so what an agent does is
   * written where it is defined; agents that share extensions share a list
   * (`extensions: [...shared, "plan-mode"]`). A later extension's tool replaces an earlier one, or
   * one of `tools`, of the same name. The runtime refuses to start when a name has no provider.
   */
  extensions?: readonly string[];
  /**
   * The skills it knows, and only these (the Agent Skills format: `defineSkill` over a `SKILL.md`):
   * instructions for a kind of task, which it loads when a task matches a skill's description. A
   * string names a skill the project installed under the keyed capability `agent.skill` (its catalog:
   * `"review"`); an object is a skill of the agent's own. As with tools, installing a skill gives no
   * agent anything until it names it, and the runtime refuses to start when a name has no provider. The
   * runtime lists each one's name and description in the system prompt and gives the agent the tool
   * `skill`, which returns a skill's instructions by name (and where its files are, when it has a
   * `location`). A skill is data the project ships, read when the agent is defined: changing one is a
   * change to the project, through its deploy (SPEC §6), never something a run writes. Absent or empty:
   * no skills, no section and no `skill` tool, so an agent that has a tool of its own named `skill` has
   * no skills.
   */
  skills?: readonly (AgentSkill | string)[];
  /**
   * The initial state of each conversation: a JSON object. Tools update it through `AGENT_STATE`;
   * it is stored in the runtime's conversation and starts again from here after a reset. Absent,
   * it is `{}`.
   */
  state?: S;
  /**
   * Runs before every run of a conversation, and again whenever a tool updates its state, with the
   * conversation's current state, and returns what changes from then on: model, system prompt, tools,
   * extensions. It is the simple path, for an agent that switches with its state (a phase, a mode).
   * It must be pure and synchronous: it returns a value and registers nothing, so it is also a plain
   * function in tests (`agent.prepare?.(state, ctx)`). Anything that reads a store, waits, or must
   * see each model request or tool call is an extension (`extensions`), not `prepare`. Without it,
   * every run has the static fields above.
   */
  prepare?(state: Readonly<S>, ctx: PrepareContext): TurnChanges;
}

const AGENT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** The name a model calls a tool by: letters, digits, `_` and `-`. */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** `provider/modelId`; the model id may contain slashes of its own (`openrouter/anthropic/x`). */
const MODEL = /^[^/\s]+\/\S+$/;
/** The name an agent extension is provided under (`agent.extension`). */
const EXTENSION_NAME = /^\S+$/;

/** Check an agent definition's shape and return it unchanged. */
export function defineAgent<S extends object = object>(definition: AgentDefinition<S>): AgentDefinition<S> {
  if (!AGENT_NAME.test(definition.name)) {
    throw new Error(`agent name "${definition.name}" must be kebab-case (e.g. "support")`);
  }
  if (!MODEL.test(definition.model)) {
    throw new Error(`agent "${definition.name}": model "${definition.model}" must be "provider/modelId"`);
  }
  if (definition.steward !== undefined && typeof definition.steward !== "boolean") {
    throw new Error(`agent "${definition.name}": steward must be true or false`);
  }
  const named = (definition.tools ?? []).filter((tool): tool is string => typeof tool === "string");
  for (const [index, name] of named.entries()) {
    if (!TOOL_NAME.test(name)) throw new Error(`agent "${definition.name}": tool name "${name}" is not a tool name`);
    if (named.indexOf(name) !== index) throw new Error(`agent "${definition.name}": tool "${name}" is named twice`);
  }
  const extensions = definition.extensions ?? [];
  for (const [index, name] of extensions.entries()) {
    if (typeof name !== "string" || !EXTENSION_NAME.test(name)) {
      throw new Error(`agent "${definition.name}": extension name ${JSON.stringify(name)} must be a non-empty name without spaces`);
    }
    if (extensions.indexOf(name) !== index) throw new Error(`agent "${definition.name}": extension "${name}" is named twice`);
  }
  const toolNames = (definition.tools ?? []).map((tool) => (typeof tool === "string" ? tool : (tool as { name?: unknown } | null)?.name)).filter((name) => typeof name === "string");
  const problem = skillsProblem(definition.skills ?? [], toolNames);
  if (problem !== undefined) throw new Error(`agent "${definition.name}": ${problem}`);
  // Checked here, not at the first update: the state is stored in the conversation as JSON.
  if (definition.state !== undefined && !isJsonObject(definition.state)) {
    throw new Error(`agent "${definition.name}": state must be a JSON object`);
  }
  return definition;
}

/**
 * What is wrong with an agent's skills, or `undefined`: each must be a skill's name (an installed
 * `agent.skill`) or a skill (`defineSkill`), no two of one name, and none beside a tool the agent names
 * `skill` (the runtime's own tool for them). `tools`: the names of the agent's tools. `defineAgent`
 * checks the definition; the runtime checks what `prepare` returns with it too, once names are skills.
 */
export function skillsProblem(skills: readonly (AgentSkill | string)[], tools: readonly string[]): string | undefined {
  if (!Array.isArray(skills)) return "skills must be a list of skills' names or skills (defineSkill)";
  const names: string[] = [];
  for (const skill of skills) {
    if (typeof skill === "string" && !isSkillName(skill)) return `skill name ${JSON.stringify(skill)} must be lowercase letters, digits and single hyphens, at most 64 characters`;
    const problem = typeof skill === "string" ? undefined : skillProblem(skill);
    if (problem !== undefined) return problem;
    const name = typeof skill === "string" ? skill : skill.name;
    if (names.includes(name)) return `skill "${name}" is given twice`;
    names.push(name);
  }
  if (names.length > 0 && tools.includes(SKILL_TOOL)) return `it has skills and a tool named "${SKILL_TOOL}", the runtime's tool that loads them: rename the tool`;
  return undefined;
}

/** The name of the tool the runtime gives an agent with skills, which loads one by name. */
export const SKILL_TOOL = "skill";

/**
 * What is wrong with an App's agents taken together, or `undefined`: more than one of them is the steward
 * (`AgentDefinition.steward`, SPEC §6). `defineAgent` sees one agent; the runtime sees them all, so it
 * calls this at start with every `agent.definition` and refuses to start on a problem (the
 * `agent.runtime` suite checks it does).
 */
export function stewardProblem(agents: readonly Pick<AgentDefinition, "name" | "steward">[]): string | undefined {
  const stewards = agents
    .filter((agent) => agent.steward === true)
    .map((agent) => agent.name)
    .sort();
  if (stewards.length <= 1) return undefined;
  return `agents ${stewards.map((name) => `"${name}"`).join(" and ")} are each marked \`steward: true\`; a project has one steward, its main agent: take it off the others`;
}

/**
 * An image a message carries (pi-ai's `ImageContent`): what a model that reads images sees with the
 * prompt.
 */
export interface AgentImage {
  /** Its media type: `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
  mimeType: string;
  /** Its bytes, base64 (standard alphabet, padded), without a `data:` prefix. */
  data: string;
}

/**
 * Who sent a message, as its producer established it: a channel's authenticated user
 * (`InboundMessage.actor`), the dashboard's operator, an agent that delegated work. Trusted data, never
 * the model's: a tool or a hook decides with it (whose memory, which rules) without asking the model.
 */
export interface Sender {
  /** Who established it: the channel's name (`telegram`, `http`), `dashboard`, or the producer's own. */
  channel: string;
  /** Its id there (`InboundMessage.actor.id`, an operator's id, an agent's name). */
  id: string;
}

/**
 * One inbound message for a conversation. The agent is `conversation.agent`: a resumed run has no
 * request to carry a definition, so the name is the only truth. Quoted messages and message prompts
 * are added with the components that produce them.
 */
export interface AgentRequest {
  /** Logical identity of the message (`InboundMessage.id`); the request id pi-durable deduplicates by. */
  requestId: string;
  conversation: ConversationRef;
  prompt: string;
  /**
   * Images the message carries, in order. The runtime puts them in the user message after the prompt's
   * text, so the model reads them with it (a model that reads no images is told one was omitted), and
   * they stay in the transcript. Whoever builds the request bounds their number
   * and size: the runtime stores them as they are (on Cloudflare one Durable Object row holds at most
   * 2 MB). Absent or empty: a message of text only.
   */
  images?: readonly AgentImage[];
  /**
   * What the message does to a conversation with a run going. `followUp` (the default): it waits for
   * that run to end, and the next run answers it. `steer`: it joins the run in progress after the
   * run's current tool round (a person correcting course; never the dashboard's operator, whose
   * message is a follow-up, SPEC §5), and that
   * run's result answers it with the others it took (`AgentResult.requestIds`); a run that answers
   * before another tool round leaves it to the next run, as a follow-up. A conversation with no run
   * going starts one either way.
   */
  whenBusy?: "followUp" | "steer";
  /**
   * Who sent it. The runtime keeps it with the message, durably, and gives it to the run that takes the
   * message: its tools, hooks and system prompt sections read the run's requests and their senders
   * through `RUN_REQUESTS` (`run-requests.ts`), also after a restart. It is not in the run's result nor
   * in `agent.submissions`: a producer that needs it there knows its own senders. Absent: unknown (a
   * producer that authenticates no one).
   */
  sender?: Sender;
  /**
   * Parts the message brings to the answer of the run that takes it (`AgentResult.parts`): what the
   * person must see with that answer that the message's producer, not the run, has (a question a
   * delegated task asked, which its report carries to the delegating conversation). Each one a part
   * (`partProblem`): the runtime refuses the message otherwise, and nothing is admitted. The runtime
   * keeps them with the message, durably, so the run's result has them once, whichever worker ends it;
   * a duplicate brings nothing. Whoever builds the request bounds their number and size, as images'.
   * Absent or empty: none.
   */
  parts?: readonly MessagePart[];
}

/** What happened to a message, known as soon as it is durable in the runtime's conversation. */
export type Admission =
  /** The conversation was idle: a run started, identified by this request. */
  | { kind: "started"; requestId: string }
  /**
   * The conversation was busy: the message waits in the conversation's inbox. Every follow-up queued
   * while a run goes is taken together by the next run, which starts once the run in progress ends and
   * answers them all (its `requestIds`); its `agent.started` names the first of them. A steer joins the
   * run in progress at its next tool round instead (`AgentRequest.whenBusy`).
   */
  | { kind: "queued"; requestId: string }
  /** The conversation already has this request: nothing runs. */
  | { kind: "duplicate"; requestId: string };

/** How one run ended: the payload of `agent.settled` and `agent.failed`. */
export interface AgentResult {
  conversation: ConversationRef;
  /** The request that started the run. */
  requestId: string;
  /**
   * Every request the run took, in order: the one that started it, then the other messages that were
   * queued with it while the run before it went (they are taken together), and the steers that joined
   * it. The run's answer answers all of them, so a channel that replies per message replies to each. A
   * message withdrawn by `abort()` is not among them.
   */
  requestIds: string[];
  kind: "completed" | "aborted" | "failed";
  /** The run's final answer, when it produced one. */
  text?: string;
  /**
   * What its answer carries besides its text (a question to draw as buttons, `parts.ts`): first the
   * parts of the messages it took (`AgentRequest.parts`), in the order it took them, then the parts its
   * tools gave, in the order their results were written. Answer delivery sends a completed run's with
   * its text, also when it has none. A tool gives them through its result (runtime-pi: `withParts`,
   * `@pikit/pi-adapter/tools`). Absent: none.
   */
  parts?: readonly MessagePart[];
  /** What the run added to the transcript. */
  messages: AgentMessage[];
  usage?: Usage;
  error?: { code: string; message: string };
}

/** The `agent.runtime` capability. */
export interface AgentRuntime {
  /**
   * Hand a message to its conversation, as a follow-up or a steer (`AgentRequest.whenBusy`). Resolves
   * once the message is durable (the ack point for a channel), not when it is answered. `ctx` bounds
   * this call only: cancelling it never stops a run. Opening a conversation first continues the runs a
   * dead worker left open.
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

/**
 * The `agent.conversations` capability: where the runtime keeps conversations. Provided by the agent
 * runtime (`runtime-pi`) and used by `conversations.registry`, which records which key points to
 * which conversation: a first message and a reset each create one here.
 */
export interface AgentConversations {
  /**
   * A new, empty conversation in the runtime's storage: its id, the `ConversationRef.conversationId`
   * of every message sent to it. Usable once the runtime has started.
   */
  create(ctx: AppContext): Promise<string>;
}

declare module "@pikit/core" {
  interface AppEvents {
    /** Every admission, duplicates included. Emitted by the runtime in the caller's context. */
    "agent.dispatched": { conversation: ConversationRef; admission: Admission };
    /** A run started, or a new worker resumed one. */
    "agent.started": { conversation: ConversationRef; requestId: string; resumed: boolean };
    /**
     * The answer as the model writes it: the text so far of the response it is writing now (each model
     * call of the run starts again), while the run goes, at most once per the runtime's interval (its
     * value). `requestId` is the run's, as in `agent.started`. A notice for a preview (a placeholder
     * edited as the answer grows): one lost costs nothing, none comes after the run's end, and the
     * answer itself is the run's result. Emitted in the run's context, never awaited by it.
     */
    "agent.partial": { conversation: ConversationRef; requestId: string; text: string };
    /** A run ended with an answer or was aborted, whether or not anyone waits for it. */
    "agent.settled": AgentResult & { kind: "completed" | "aborted" };
    /** A run failed. */
    "agent.failed": AgentResult & { kind: "failed" };
  }
}

declare module "@pikit/core" {
  interface AppCapabilities {
    "agent.runtime": AgentRuntime;
    "agent.conversations": AgentConversations;
  }
  interface AppKeyedCapabilities {
    /** One per agent, keyed by its name; provided by the project. */
    "agent.definition": AgentDefinition;
    /** One per tool, keyed by the name the model calls it by; provided by `tool-*` components. */
    "agent.tool": AgentTool;
    /**
     * One per skill, keyed by its name (`AgentSkill.name`): the project's catalog, which agents name in
     * their `skills`; provided by the project (`defineSkill` over each `SKILL.md`).
     */
    "agent.skill": AgentSkill;
  }
}
