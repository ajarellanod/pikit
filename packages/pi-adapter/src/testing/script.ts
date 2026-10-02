/**
 * The scripted agent of the `agent.runtime` conformance suite, on pi-ai 1.0's faux provider: each
 * turn answers `answer: <newest user message>`, and a turn whose newest message is exactly `hold`
 * first calls the `hold` tool.
 *
 * For component and sample tests, more rules: a message `bash: <command>` calls the `bash` tool with
 * that command, and the turn after a `bash` result answers `tool said: <result>`; a message
 * `call: <tool> <json arguments>` calls any tool with those arguments. pi-durable places its
 * `pi.system` entries (instructions, tools) after the input, so "newest" skips system messages.
 *
 * Neutral: it runs on every target (the workerd lane uses it).
 */

import type { Context as ChordContext } from "@earendil-works/chord";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { type FauxResponseFactory, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { type AgentDefinition, defineAgent } from "@pikit/contracts";

/** How many model calls one provider answers; faux consumes one response per call. */
const CALLS = 1000;

/** What the provider was asked: the context of one model request. */
export type ModelRequest = Parameters<FauxResponseFactory>[0];
type Message = ModelRequest["messages"][number];

function textOf(message: Message | undefined): string {
  if (message === undefined || message.role === "system") return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export interface ScriptedProviderOptions {
  /** Provider id. Default `faux`; its model is `<id>/scripted`. */
  id?: string;
  /** Sees every request, and the stream options it was sent with. */
  onRequest?(request: ModelRequest, options: Parameters<FauxResponseFactory>[1]): void;
  /**
   * The provider is configured only when this API key is stored for it in `model.credentials`, as a
   * real provider without credentials. Default: always configured, with no credentials at all.
   */
  apiKey?: string;
  /**
   * Asked before each answer. A promise makes that model call wait for it, then fail with its text as
   * the provider's error (a model error pi-durable does not retry). `undefined` answers as usual.
   */
  fail?(): Promise<string> | undefined;
  /**
   * Asked before each final answer (one that calls no tool). A promise holds the answer, and so the
   * run, until it resolves: the run is at its end and has not ended yet.
   */
  atEnd?(): Promise<void> | undefined;
}

/** The scripted provider, model `<id>/scripted`. */
export function scriptedProvider(options: ScriptedProviderOptions = {}): Provider {
  const faux = fauxProvider({ provider: options.id ?? "faux", models: [{ id: "scripted" }] });
  const step: FauxResponseFactory = (context, streamOptions) => {
    options.onRequest?.(context, streamOptions);
    const failing = options.fail?.();
    if (failing !== undefined) return failing.then((errorMessage) => fauxAssistantMessage("", { stopReason: "error", errorMessage }));
    const answer = respond(context);
    if (answer.stopReason === "toolUse") return answer;
    const holding = options.atEnd?.();
    return holding === undefined ? answer : holding.then(() => answer);
  };
  faux.setResponses(Array.from({ length: CALLS }, () => step));
  const apiKey = options.apiKey;
  if (apiKey === undefined) return faux.provider;
  // The same models and streams, behind API-key auth that only a stored credential satisfies.
  return {
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Scripted API key",
        resolve: async ({ credential }) => (credential?.type === "api_key" && credential.key === apiKey ? { auth: { apiKey }, source: "stored credential" } : undefined),
      },
    },
  };
}

function respond(context: ModelRequest): ReturnType<typeof fauxAssistantMessage> {
  const last = [...context.messages].reverse().find((message) => message.role !== "system");
  if (last?.role === "user" && textOf(last) === "hold") return fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" });
  const call = last?.role === "user" ? /^call: (\S+)(?: (.+))?$/s.exec(textOf(last)) : null;
  if (call?.[1] !== undefined) return fauxAssistantMessage(fauxToolCall(call[1], JSON.parse(call[2] ?? "{}")), { stopReason: "toolUse" });
  const command = last?.role === "user" ? /^bash: (.+)$/s.exec(textOf(last))?.[1] : undefined;
  if (command !== undefined) return fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" });
  if (last?.role === "toolResult" && last.toolName === "bash") return fauxAssistantMessage(`tool said: ${textOf(last)}`);
  const newest = [...context.messages].reverse().find((message) => message.role === "user");
  return fauxAssistantMessage(`answer: ${textOf(newest)}`);
}

/**
 * The `hold` tool: its result is whatever `run` resolves to. Its replay is `unsafe` by default: an
 * interrupted call is not run again, the model gets an `interrupted` error result instead.
 */
export function holdTool(run: (context: ChordContext) => Promise<string>, replay: "safe" | "unsafe" = "unsafe"): ToolRegistration {
  return defineTool({
    name: "hold",
    description: "Blocks until the test releases it.",
    parameters: Type.Object({}),
    replay,
    execute: async (_args, _api, context) => ({ content: [{ type: "text", text: await run(context) }] }),
  }) as unknown as ToolRegistration;
}

/** A stand-in for the `bash` tool: it runs nothing, records each command in `ran`, and returns `ran`. */
export function recordingBash(ran: string[]): ToolRegistration {
  return defineTool({
    name: "bash",
    description: "Records the commands it is asked to run",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (args) => {
      ran.push(args.command);
      return { content: [{ type: "text", text: "ran" }] };
    },
  }) as unknown as ToolRegistration;
}

/** The suite's agent over `faux/scripted`, with the `hold` tool. */
export function scriptedAgent(hold: ToolRegistration): AgentDefinition {
  return defineAgent({ name: "scripted", model: "faux/scripted", tools: [hold] });
}
