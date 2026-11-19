/**
 * What admin-api reads and does where a conversation is (`ConversationHost`): the App that runs it (a
 * server's, or on Cloudflare its key's Durable Object, `createLocalHost`), or the Worker reaching that
 * object by calls (`createRemoteHost`, `remote.ts`). What the directory does not hold is asked here: the
 * conversation as the runtime has it (busy, usage), who it is with (`party.ts`), its transcript and live
 * events; and every action: a message, an abort, a reset, a slash command, a new conversation.
 *
 * A conversation is named by its key and the runtime's own id there (`HostRef`); the routes' ids
 * (`<key>~<id>`) are `backend.ts`'.
 *
 * **What the operator writes** (the dashboard is a channel of its own): a message to a conversation is
 * a follow-up, never a steer, whose request id starts with `dashboard:` (`DASHBOARD_REQUEST_PREFIX`),
 * so that a run only such messages started is never delivered to the conversation's chat; the agent
 * reads it after a first line saying it is the operator's (`operatorPrompt`), which also asks for a web
 * search when the message does (only of an agent with `WEB_SEARCH_TOOL`), and its images in the
 * request (`AgentRequest.images`). A new conversation is one of the dashboard's own
 * (`dashboard:<uuid>`), with an agent of the App, in its operator's space (`operatorSpace`: every
 * conversation an operator starts shares their memory and saved files), owned by its operator
 * (`operatorPrincipal`: the directory's owner). A slash command (`agent.command`, the App's) runs
 * in a conversation as the other actions do: only in a key's current one (`runAgentCommand`); the
 * prompt one answers (a prompt template's) is dispatched as an operator's message, as `send` does.
 *
 * **Which conversation a ref names.** The runtime's conversation `conversationId` whose key is `key`:
 * the key `agent.observe` knows once a message reached it, or, before that (a reset's new one), the key
 * that points to it now (`conversations.registry`'s `get`, which also gives its agent: a key keeps its
 * agent through resets). Any other is `not_found`, as is a ref whose key is not the conversation's.
 *
 * A refusal is an `ActorCallError` whose code the routes answer with (`not_found` and
 * `unknown_command` are a `404`, `no_agent` and `not_current` a `409`, `invalid_cursor` and
 * `invalid_request` a `400`, `command_failed` a `422`): the same error crosses a call from an object to
 * the Worker whole.
 */

import { APP_DESCRIPTION, type AppContext } from "@pikit/core";
import {
  ActorCallError,
  type AgentObserver,
  type AgentRuntime,
  type CommandLookup,
  type ConversationRef,
  type ConversationRegistry,
  DASHBOARD_REQUEST_PREFIX,
  isAgentUnavailable,
  listAgentCommands,
  operatorPrincipal,
  type PageRequest,
  redactSecrets,
  runAgentCommand,
} from "@pikit/contracts";
import {
  type ApiAgent,
  type ApiAgents,
  type ApiApp,
  type ApiAttachment,
  type ApiCommandResponse,
  type ApiCommands,
  type ApiConversation,
  type ApiEvent,
  type ApiPage,
  type ApiResetResponse,
  type ApiSendResponse,
  type ApiStartResponse,
  type ApiSummary,
  type ApiTranscriptEntry,
  type ApiUsage,
  isDashboardKey,
  operatorPrompt,
  operatorSpace,
  SUMMARY_MAX,
  WEB_SEARCH_TOOL,
} from "./api.ts";
import { partyOf } from "./party.ts";

/** A conversation where it is: its key, and the runtime's id there. */
export interface HostRef {
  key: string;
  conversationId: string;
}

/**
 * A message to a conversation, checked: what `POST …/messages` takes (its attachments by
 * `attachmentsProblem`). Its request id starts with `dashboard:`.
 */
export interface Message {
  text: string;
  requestId: string;
  attachments?: ApiAttachment[];
  /** Asks the agent to search the web: its agent must have `WEB_SEARCH_TOOL` (else `invalid_request`). */
  webSearch?: boolean;
  /**
   * The operator who sends it (`Operator.id`, from `admin.auth`): the request's sender, `{ channel:
   * "dashboard", id }`, which the run's tools and hooks read (`RUN_REQUESTS`).
   */
  operator?: string;
}

/** A new conversation of the dashboard's own, checked: what `POST /admin/api/conversations` takes. */
export interface NewConversation extends Message {
  /** `dashboard:<uuid>`, made by the routes. */
  key: string;
  agent: string;
}

/**
 * What is where the conversation is. Every answer names conversations by the runtime's own id there
 * (`ApiConversation.conversationId`, `currentId`, a reset's and a start's ids); `backend.ts` names them
 * for the routes.
 */
export interface ConversationHost {
  /** The composition of the App that runs the agents. */
  app(ctx: AppContext): Promise<ApiApp>;
  /** The App's agents, by name. */
  agents(ctx: AppContext): Promise<ApiAgents>;
  /** The App's slash commands (`agent.command`), by name. */
  commands(ctx: AppContext): Promise<ApiCommands>;
  /** The conversation as the runtime has it, whether its key points to it now, who it is with. Throws `not_found`. */
  conversation(ref: HostRef, ctx: AppContext): Promise<ApiConversation>;
  /** Newest first. Throws `not_found`, `invalid_cursor`. */
  transcript(ref: HostRef, page: PageRequest, ctx: AppContext): Promise<ApiPage<ApiTranscriptEntry>>;
  /**
   * Its live events, its whole live state first (a `live` event, `[["r", value]]`), until `ctx` is cancelled or they end. Throws `not_found`
   * before the first one, so a route answers `404` rather than an empty stream.
   */
  live(ref: HostRef, ctx: AppContext): Promise<AsyncIterable<ApiEvent>>;
  /** Throws `not_found`. */
  usage(ref: HostRef, ctx: AppContext): Promise<ApiUsage>;
  /**
   * The actions reach only a key's current conversation: they throw `not_found`, `no_agent` (its agent
   * is gone), `not_current`; a message also `invalid_request` (a web search its agent cannot do,
   * attachments the API does not take) and `too_large`.
   */
  send(ref: HostRef, message: Message, ctx: AppContext): Promise<ApiSendResponse>;
  abort(ref: HostRef, ctx: AppContext): Promise<void>;
  reset(ref: HostRef, ctx: AppContext): Promise<ApiResetResponse>;
  /**
   * Runs the command `name` in the conversation with `args`, as an action: it throws
   * `unknown_command` (no such command, before anything else), the actions' refusals, and
   * `command_failed` with the command's message.
   */
  command(ref: HostRef, name: string, args: string, ctx: AppContext): Promise<ApiCommandResponse>;
  /** A conversation of the dashboard's own, with its first message. Throws `unknown_agent`, `invalid_request`. */
  start(conversation: NewConversation, ctx: AppContext): Promise<ApiStartResponse>;
}

/** A refusal the routes answer with: `code` is the API's `error`. */
export function refusal(
  code: "not_found" | "no_agent" | "not_current" | "invalid_cursor" | "invalid_request" | "unknown_agent" | "too_large" | "unknown_command" | "command_failed" | "forbidden",
  message: string,
): ActorCallError {
  return new ActorCallError(code, message);
}

export const NOT_FOUND = "no such conversation";

/** The channel of an operator's messages, as their sender says it (`AgentRequest.sender`). */
export const DASHBOARD_CHANNEL = "dashboard";

export interface LocalContracts {
  observe(): AgentObserver;
  runtime(): AgentRuntime;
  registry(): ConversationRegistry;
  /** The App's agents now: the code's (`agent.definition`, `agentOf` describes each) by name, then the live ones (`agent.directory`). */
  agents(ctx: AppContext): Promise<ApiAgent[]>;
  /** The App's slash commands (`agent.command`). */
  commands(): CommandLookup;
  /** Every tool and skill an agent may have, each with its one line (`summariesOf`). */
  summaries(): Pick<ApiAgents, "tools" | "skills">;
}

/**
 * `text`'s first sentence, as an operator reads it in one line: its spaces collapsed, without a final
 * period, at most `SUMMARY_MAX` characters (cut at a word, with an ellipsis). "" when it is no text.
 */
export function summaryOf(text: unknown): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](?:\s|$)/);
  const sentence = (end === -1 ? flat : flat.slice(0, end + 1)).replace(/\.$/, "");
  if (sentence.length <= SUMMARY_MAX) return sentence;
  const cut = sentence.slice(0, SUMMARY_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).replace(/[.,;:\s]+$/u, "")}…`;
}

/** Something named, an object: a tool or a skill an agent's definition holds itself (not a name). */
const named = (value: unknown): value is { name: string; summary?: unknown; description?: unknown } =>
  typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";

/**
 * The tools and skills agents may have (`ApiAgents.tools`, `skills`): the installed ones (`agent.tool`,
 * `agent.skill`) by name, then those the code's definitions hold themselves, each name once. A tool's
 * line is its `summary` (the one its component wrote for an operator), else its description's first
 * sentence; a skill's, its description's (`summaryOf` both).
 */
export function summariesOf(
  installed: { tools: readonly (readonly [string, unknown])[]; skills: readonly (readonly [string, unknown])[] },
  definitions: readonly ({ tools?: readonly unknown[]; skills?: readonly unknown[] } | undefined)[],
): Pick<ApiAgents, "tools" | "skills"> {
  const toolLine = (tool: unknown) => {
    const own = named(tool) ? summaryOf(tool.summary) : "";
    return own !== "" ? own : named(tool) ? summaryOf(tool.description) : "";
  };
  const skillLine = (skill: unknown) => (named(skill) ? summaryOf(skill.description) : "");
  const list = (entries: readonly (readonly [string, unknown])[], own: unknown[], line: (each: unknown) => string): ApiSummary[] => {
    const seen = new Set<string>();
    const all = [...[...entries].sort(([a], [b]) => a.localeCompare(b)), ...own.filter(named).map((each) => [each.name, each] as const).sort(([a], [b]) => a.localeCompare(b))];
    return all.flatMap(([name, each]) => (seen.has(name) ? [] : (seen.add(name), [{ name, summary: line(each) }])));
  };
  return {
    tools: list(installed.tools, definitions.flatMap((each) => [...(each?.tools ?? [])]), toolLine),
    skills: list(installed.skills, definitions.flatMap((each) => [...(each?.skills ?? [])]), skillLine),
  };
}

/** An agent definition as the API says it: its name, its model, the names of the tools it is defined with, whether it is the steward. */
export function agentOf(name: string, definition: { model?: unknown; tools?: readonly unknown[]; steward?: unknown } | undefined): ApiAgent {
  const tools = (definition?.tools ?? []).flatMap((tool) => {
    const named = typeof tool === "string" ? tool : (tool as { name?: unknown } | null)?.name;
    return typeof named === "string" ? [named] : [];
  });
  return { name, model: typeof definition?.model === "string" ? definition.model : "", tools, steward: definition?.steward === true };
}

/** The host over the contracts of the App it runs in (a server's, or one Durable Object's). */
export function createLocalHost(contracts: LocalContracts): ConversationHost {
  /**
   * The conversation `ref` names (see the header), with its agent, whether its key points to it now
   * (and else which one it does), and the channel recorded with its key. Throws `not_found`.
   */
  const found = async (ref: HostRef, ctx: AppContext) => {
    const observed = ref.conversationId === "" ? undefined : await contracts.observe().conversation(ref.conversationId, ctx);
    if (observed === undefined || (observed.key !== undefined && observed.key !== ref.key)) throw refusal("not_found", NOT_FOUND);
    const now = await contracts.registry().get(ref.key, ctx);
    const current = now?.conversationId === ref.conversationId;
    const agent = observed.agent ?? now?.agent;
    // No message reached it: only the key's current one is the key's (a reset's new one).
    if ((observed.key === undefined && !current) || agent === undefined) throw refusal("not_found", NOT_FOUND);
    return { observed, agent, current, now };
  };

  /** The conversation as an action takes it, or why not: a reset left it behind. */
  const actionable = async (ref: HostRef, ctx: AppContext): Promise<ConversationRef> => {
    const { agent, current } = await found(ref, ctx);
    if (!current) throw refusal("not_current", "a reset left this conversation behind: its key points to another one");
    return { key: ref.key, agent, conversationId: ref.conversationId };
  };

  /** A read with the client's cursor: an observer refuses a cursor it did not give. */
  const paged = async <T>(page: PageRequest, read: () => Promise<T>): Promise<T> => {
    if (page.cursor === undefined) return read();
    try {
      return await read();
    } catch {
      throw refusal("invalid_cursor", "the cursor is not one this API gave");
    }
  };

  /** Whether `message` asks for a web search; one that `agent` cannot do is refused. */
  const searchable = async (agent: string, message: Message, ctx: AppContext): Promise<boolean> => {
    if (message.webSearch !== true) return false;
    if (!(await contracts.agents(ctx)).some((each) => each.name === agent && each.tools.includes(WEB_SEARCH_TOOL))) {
      throw refusal("invalid_request", `the agent "${agent}" has no ${WEB_SEARCH_TOOL} tool: it cannot search the web`);
    }
    return true;
  };

  /**
   * Dispatches `message` to `conversation` as the operator's: a follow-up, marked for the agent, with its
   * images. A web search is asked only of an agent that has the tool.
   */
  const dispatch = async (conversation: ConversationRef, message: Message, ctx: AppContext) => {
    const webSearch = await searchable(conversation.agent, message, ctx);
    const images = (message.attachments ?? []).map(({ mimeType, data }) => ({ mimeType, data }));
    const prompt = operatorPrompt(conversation.key, message.text, { webSearch });
    try {
      const sender = message.operator === undefined ? {} : { sender: { channel: DASHBOARD_CHANNEL, id: message.operator } };
      return await contracts.runtime().dispatch({ requestId: message.requestId, conversation, prompt, ...(images.length > 0 && { images }), whenBusy: "followUp", ...sender }, ctx);
    } catch (error) {
      // Its agent is gone for good (removed, a live agent deleted): a refusal, not a failure. A message
      // from its channel moves the key to the agent routed now; `/new` here keeps the agent.
      if (isAgentUnavailable(error)) throw refusal("no_agent", `this conversation's agent "${conversation.agent}" is no agent now: ${error.message}`);
      throw error;
    }
  };

  return {
    async app(ctx) {
      const description = ctx.value(APP_DESCRIPTION) as unknown as ApiApp;
      // Config holds no secret; one put there by mistake is still never sent.
      return { ...description, config: redactSecrets(description.config) };
    },

    agents: async (ctx) => ({ items: await contracts.agents(ctx), ...contracts.summaries() }),

    commands: async () => ({ items: listAgentCommands(contracts.commands()) }),

    async conversation(ref, ctx) {
      const { observed, agent, current, now } = await found(ref, ctx);
      const party = await partyOf(ref.key, ref.conversationId, now?.channel, ctx);
      return {
        ...(observed as Omit<ApiConversation, "key" | "agent" | "current">),
        key: ref.key,
        agent,
        current,
        ...(!current && now !== undefined && { currentId: now.conversationId }),
        party,
      };
    },

    async transcript(ref, page, ctx) {
      await found(ref, ctx);
      const result = await paged(page, () => contracts.observe().transcript(ref.conversationId, page, ctx));
      if (result === undefined) throw refusal("not_found", NOT_FOUND);
      return result as ApiPage<ApiTranscriptEntry>;
    },

    async live(ref, ctx) {
      // `watch` rejects an unknown conversation only once read: ask first.
      await found(ref, ctx);
      return contracts.observe().watch(ref.conversationId, ctx);
    },

    async usage(ref, ctx) {
      await found(ref, ctx);
      const usage = await contracts.observe().usage(ref.conversationId, ctx);
      if (usage === undefined) throw refusal("not_found", NOT_FOUND);
      return usage as ApiUsage;
    },

    async send(ref, message, ctx) {
      const admission = await dispatch(await actionable(ref, ctx), message, ctx);
      return { requestId: message.requestId, admission: admission.kind };
    },

    async abort(ref, ctx) {
      await contracts.runtime().abort(await actionable(ref, ctx), ctx);
    },

    async reset(ref, ctx) {
      const conversation = await actionable(ref, ctx);
      const reset = await contracts.registry().reset(conversation.key, undefined, ctx);
      if (reset === undefined) throw refusal("not_found", NOT_FOUND);
      return { key: conversation.key, previousConversationId: reset.previousConversationId, conversationId: reset.newConversationId };
    },

    async command(ref, name, args, ctx) {
      const commands = contracts.commands();
      if (!listAgentCommands(commands).some((each) => each.name === name)) throw refusal("unknown_command", `no command "/${name}" in the App`);
      const conversation = await actionable(ref, ctx);
      const outcome = await runAgentCommand(commands, name, conversation, args, ctx);
      if (outcome.kind === "unknown") throw refusal("unknown_command", `no command "/${name}" in the App`);
      if (outcome.kind === "failed") throw refusal("command_failed", outcome.message);
      // A prompt template's expansion: the operator's message to the agent, whose answer is the dashboard's.
      if (outcome.prompt !== undefined) await dispatch(conversation, { text: outcome.prompt, requestId: `${DASHBOARD_REQUEST_PREFIX}${crypto.randomUUID()}` }, ctx);
      return outcome.text === undefined ? {} : { text: outcome.text };
    },

    async start(message, ctx) {
      if (!isDashboardKey(message.key)) throw refusal("invalid_request", "a conversation the dashboard starts has a key of its own, dashboard:<id>");
      const agents = (await contracts.agents(ctx)).map((agent) => agent.name);
      if (!agents.includes(message.agent)) throw refusal("unknown_agent", `no agent "${message.agent}" in the App: ${agents.join(", ") || "none"}`);
      // Before the key is made: a refused message makes no conversation.
      await searchable(message.agent, message, ctx);
      // The dashboard's own conversation: its channel is the dashboard's, its space and owner its operator's, for good.
      const place = {
        channel: DASHBOARD_CHANNEL,
        ...(message.operator !== undefined && { space: operatorSpace(message.operator), owner: operatorPrincipal(message.operator) }),
      };
      const conversation = await contracts.registry().resolve(message.key, message.agent, place, ctx);
      const admission = await dispatch(conversation, message, ctx);
      return { key: conversation.key, conversationId: conversation.conversationId, requestId: message.requestId, admission: admission.kind };
    },
  };
}
