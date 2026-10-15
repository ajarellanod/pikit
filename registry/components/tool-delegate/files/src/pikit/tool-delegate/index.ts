/**
 * tool-delegate: the agent tool `delegate`, for the agents that name it (`tools: ["delegate"]`). It
 * hands a task to another agent of the project, the ones its config lists, and gets the answer: now
 * (`wait`, the default), or later, as a message in the conversation (`wait: false`).
 *
 * - **The task is a child conversation** of the agent the call names, on pi-durable's subagents, which
 *   the runtime gives tools through their context (`AGENT_DELEGATION`, `@pikit/pi-adapter/tools`):
 *   `run` (the child is owned by the call: stopping the parent's run stops it) or `start` (the child
 *   outlives the run; its answer is admitted to this conversation when it ends). It lives in this
 *   conversation's storage: the same on a server as in a Durable Object.
 * - **Which agents, and how deep**, is this tool's config: the agents it may hand work to, each with
 *   what it is for (the model reads it to pick one), and `maxDepth`, how many delegations deep a task
 *   may be (a delegated agent that names `delegate` delegates again, one level deeper). A delegated task
 *   always waits for its own delegations: only a conversation a person started gets answers later.
 * - **The child's key** is `delegate:<depth>:<tool call's task id>`: this tool owns that namespace,
 *   and reads a conversation's depth from it. The child's sender is the delegating agent
 *   (`{ channel: "delegate", id }`), which its tools and hooks read (`RUN_REQUESTS`).
 * - **Replay is `safe`**: a call made again after a crash finds the child it created and the input it
 *   submitted (pi-durable's ownership and request ids), and only waits again.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific, and the child is the parent's
 * own storage's.
 */

import { defineComponent } from "@pikit/core";
import { CONVERSATION } from "@pikit/contracts";
import { AGENT_DELEGATION, defineTool, type ToolRegistration } from "@pikit/pi-adapter/tools";
import Type, { type Static } from "typebox";

/** The name agents give it, and its key under `agent.tool`. */
export const DELEGATE_TOOL = "delegate";
/** The prefix of a delegated task's conversation key, which this tool makes and reads. */
export const DELEGATE_KEY_PREFIX = "delegate:";
/** The channel of a delegated task's message, as its sender says it. */
export const DELEGATE_CHANNEL = "delegate";

/** An agent's name: `start` checks it is an `agent.definition`. */
const AgentName = Type.String({ minLength: 1 });

const Config = Type.Object(
  {
    /** The agents it may hand work to, each with what it is for: what the model reads to pick one. */
    agents: Type.Array(Type.Object({ name: AgentName, description: Type.String({ minLength: 1 }) }), { minItems: 1 }),
    /** How many delegations deep a task may be: 1, only the agents a person talks to delegate. */
    maxDepth: Type.Integer({ minimum: 1, maximum: 5, default: 2 }),
  },
  { examples: [{ agents: [{ name: "researcher", description: "Finds and reads sources on the web, and answers with what they say." }] }] },
);

export type DelegateConfig = Static<typeof Config>;

/** How deep a conversation is in delegations: 0 for one a person (or a channel) started. */
export function depthOf(key: string): number {
  if (!key.startsWith(DELEGATE_KEY_PREFIX)) return 0;
  const depth = Number(key.slice(DELEGATE_KEY_PREFIX.length).split(":", 1)[0]);
  return Number.isInteger(depth) && depth > 0 ? depth : 0;
}

/** The tool's description: what it does, and the agents it hands work to. */
export function delegateDescription(config: DelegateConfig): string {
  return [
    "Hands a task to another agent of this project and gets its answer. Each call is a new conversation of that agent, which starts with nothing but the task: write everything it needs in it.",
    "By default the call waits for the agent's answer. With wait: false it returns at once and the answer arrives later in this conversation, as a message: use it for long tasks, and carry on meanwhile.",
    "The agents:",
    ...config.agents.map((agent) => `- ${agent.name}: ${agent.description}`),
  ].join("\n");
}

/** The `delegate` tool for `config`. */
export function createDelegateTool(config: DelegateConfig): ToolRegistration {
  const names = config.agents.map((agent) => agent.name);
  const Parameters = Type.Object({
    agent: Type.Union(
      names.map((name) => Type.Literal(name)),
      { description: "The agent to hand the task to." },
    ),
    task: Type.String({ minLength: 1, description: "The task, with everything the agent needs to do it." }),
    wait: Type.Optional(Type.Boolean({ description: "Wait for the answer (default true), or get it later as a message (false)." })),
  });
  return defineTool({
    name: DELEGATE_TOOL,
    description: delegateDescription(config),
    parameters: Parameters,
    replay: "safe",
    async execute(args, api, context) {
      const parent = context.value(CONVERSATION);
      const delegation = context.value(AGENT_DELEGATION);
      if (parent === undefined || delegation === undefined) throw new Error("delegate runs only in a conversation's run");
      if (!names.includes(args.agent)) throw new Error(`there is no agent "${args.agent}" to delegate to; the agents are: ${names.join(", ")}`);
      const depth = depthOf(parent.key) + 1;
      if (depth > config.maxDepth) {
        throw new Error(`this task is already ${depth - 1} delegation${depth - 1 === 1 ? "" : "s"} deep, the most this project allows: do it yourself`);
      }
      const task = {
        agent: args.agent,
        key: `${DELEGATE_KEY_PREFIX}${depth}:${String(api.taskId)}`,
        channel: DELEGATE_CHANNEL,
        task: args.task,
        sender: { channel: DELEGATE_CHANNEL, id: parent.agent },
      };
      // Only a conversation a person started gets answers later: a delegated task waits for its own.
      if (args.wait === false && depth === 1) {
        await delegation.start(api, task, context);
        return { output: [{ type: "text", text: `The task is with the agent "${args.agent}" now. Its answer will arrive in this conversation as a message when it ends; carry on meanwhile.` }] };
      }
      const outcome = await delegation.run(api, task, context);
      if (outcome.kind === "completed") return { output: [{ type: "text", text: `The agent "${args.agent}" answered:\n\n${outcome.text === "" ? "(nothing)" : outcome.text}` }] };
      if (outcome.kind === "failed") throw new Error(`the agent "${args.agent}" could not do the task: ${outcome.message}`);
      throw new Error(`the agent "${args.agent}" was stopped before it answered`);
    },
  }) as unknown as ToolRegistration;
}

export default defineComponent({
  name: "tool-delegate",
  config: Config,
  setup(pikit, config) {
    const agents = pikit.useKeyed("agent.definition");
    // Under the name the model calls it by: agents name it, and runtime-pi checks the two match. Its
    // `summary` is what an operator reads next to it in the dashboard (the model reads its description).
    pikit.provideKeyed("agent.tool", DELEGATE_TOOL, { ...createDelegateTool(config), summary: "Hands a task to another agent of the project, and gets its answer" });
    return {
      start() {
        const missing = config.agents.map((agent) => agent.name).filter((name) => agents.get(name) === undefined);
        if (missing.length > 0) {
          throw new Error(`tool-delegate: ${missing.map((name) => `"${name}"`).join(", ")} in its agents is no agent.definition (agents: ${agents.keys().join(", ") || "none"}): take it out of the config, or define it`);
        }
      },
    };
  },
});
