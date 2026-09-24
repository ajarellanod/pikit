/**
 * The scripted agent of the `agent.runtime` conformance suite, on pi-ai's faux provider:
 * each turn answers `answer: <newest inbound message>`, and a turn whose newest message is exactly
 * `hold` first calls the `hold` tool.
 */

import type { AgentHarnessTool, Context } from "@earendil-works/pi-agent-core";
import { type Message, type Provider, Type } from "@earendil-works/pi-ai";
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
    const newest = [...context.messages].reverse().find((message) => message.role === "user");
    return fauxAssistantMessage(`answer: ${textOf(newest)}`);
  };
  faux.setResponses(Array.from({ length: CALLS }, () => step));
  return faux.provider;
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

/** The suite's agent over `faux/scripted`. */
export function scriptedAgent(hold: AgentHarnessTool<undefined>): AgentDefinition {
  return defineAgent({ name: "scripted", model: "faux/scripted", tools: [hold] });
}
