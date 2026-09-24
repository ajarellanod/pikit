/**
 * The scripted agent of the `agent.runtime` conformance suite, on pi-ai's faux provider:
 * each turn answers `answer: <newest inbound message>`, and a turn whose newest message is exactly
 * `hold` first calls the `hold` tool.
 *
 * For component and sample tests, two more rules: a message `bash: <command>` calls the `bash` tool
 * with that command, and the turn after a `bash` result answers `tool said: <result>`.
 */

import type { AgentHarnessTool, Context } from "@earendil-works/pi-agent-core";
import { createProvider, type Message, type Provider, Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { type AgentDefinition, defineAgent } from "@pikit/core";

/** How many model calls one provider answers; faux consumes one response per call. */
const CALLS = 1000;

function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** What the provider was asked: the context of one model request. */
export type ModelRequest = Parameters<FauxResponseFactory>[0];

export interface ScriptedProviderOptions {
  /** Provider id. Default `faux`; its model is `<id>/scripted`. */
  id?: string;
  /** Sees every request, e.g. to check what reached the model. */
  onRequest?(request: ModelRequest): void;
  /**
   * The provider is configured only when this API key is stored for it in `model.credentials`, as
   * a real provider without credentials. Default: always configured, with no credentials at all.
   */
  apiKey?: string;
}

/**
 * The scripted provider, model `<id>/scripted`. Like pi-ai's faux provider it reports prompt-cache
 * usage: `cacheRead` counts the prefix a request shares with the previous one of its session.
 */
export function scriptedProvider(options: ScriptedProviderOptions = {}): Provider {
  const faux = fauxProvider({ provider: options.id ?? "faux", models: [{ id: "scripted" }] });
  const step: FauxResponseFactory = (context) => {
    options.onRequest?.(context);
    const last = context.messages.at(-1);
    if (last?.role === "user" && textOf(last) === "hold") {
      return fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });
    }
    const command = last?.role === "user" ? /^bash: (.+)$/s.exec(textOf(last))?.[1] : undefined;
    if (command !== undefined) return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
    if (last?.role === "toolResult" && last.toolName === "bash") return fauxAssistantMessage(`tool said: ${textOf(last)}`);
    const newest = [...context.messages].reverse().find((message) => message.role === "user");
    return fauxAssistantMessage(`answer: ${textOf(newest)}`);
  };
  faux.setResponses(Array.from({ length: CALLS }, () => step));
  const apiKey = options.apiKey;
  if (apiKey === undefined) return faux.provider;
  // The same models and streams, behind API-key auth that only a stored credential satisfies.
  const provider = faux.provider;
  return createProvider({
    id: provider.id,
    auth: {
      apiKey: {
        name: "Scripted API key",
        resolve: async ({ credential }) => (credential?.key === apiKey ? { auth: { apiKey }, source: "stored credential" } : undefined),
      },
    },
    models: provider.getModels(),
    api: { stream: (model, context, streamOptions) => provider.stream(model, context, streamOptions), streamSimple: (model, context, streamOptions) => provider.streamSimple(model, context, streamOptions) },
  });
}

/** The `hold` tool: its result is whatever `run` resolves to. */
export function holdTool(
  run: (context: Context) => Promise<string>,
  replay: "safe" | "never" = "never",
): AgentHarnessTool<undefined> {
  return {
    name: "hold",
    label: "hold",
    description: "Blocks until the test releases it.",
    parameters: Type.Object({}),
    replay,
    async execute(_toolCallId, _params, _onUpdate, _toolContext, _invocation, context) {
      return { content: [{ type: "text", text: await run(context) }], details: undefined };
    },
  };
}

const COMMAND = Type.Object({ command: Type.String() });

/** A stand-in for Pi's `bash` tool: it runs nothing, records each command in `ran`, and returns `ran`. */
export function recordingBash(ran: string[]): AgentHarnessTool<undefined, typeof COMMAND> {
  return {
    name: "bash",
    label: "bash",
    description: "Records the commands it is asked to run",
    parameters: COMMAND,
    async execute(_toolCallId, params) {
      ran.push(params.command);
      return { content: [{ type: "text", text: "ran" }], details: undefined };
    },
  };
}

/** The suite's agent over `faux/scripted`. */
export function scriptedAgent(hold: AgentHarnessTool<undefined>): AgentDefinition {
  return defineAgent({ name: "scripted", model: "faux/scripted", tools: [hold] });
}
