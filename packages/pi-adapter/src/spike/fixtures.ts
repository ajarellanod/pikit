/**
 * Spike fixtures: a deterministic model built on pi-ai's faux provider, and tools whose
 * timing the tests control.
 */

import type { AgentHarnessTool, Context as PiContext } from "@earendil-works/pi-agent-core";
import { createModels, Type, type Api, type Message, type Model, type Models } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * A model that answers from the last message:
 * - `use-tool:<name>` → calls tool `<name>`;
 * - a tool result → `tool said: <result>`;
 * - anything else → `answer: <text>`.
 */
export function scriptedModel(): { models: Models; model: Model<Api> } {
  const faux = fauxProvider({ provider: "pikit-spike", models: [{ id: "scripted" }] });
  const step: FauxResponseFactory = (context) => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage(`tool said: ${textOf(last)}`);
    const said = textOf(last);
    const tool = /^use-tool:(\w+)/.exec(said)?.[1];
    if (tool !== undefined) return fauxAssistantMessage(fauxToolCall(tool, {}), { stopReason: "toolUse" });
    return fauxAssistantMessage(`answer: ${said}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => step));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() };
}

/** A tool with no parameters whose result is whatever `run` returns. */
export function tool(
  name: string,
  run: (context: PiContext) => Promise<string>,
  replay: "safe" | "never" = "never",
): AgentHarnessTool<undefined> {
  return {
    name,
    label: name,
    description: `Spike tool ${name}`,
    parameters: Type.Object({}),
    replay,
    async execute(_toolCallId, _params, _onUpdate, _toolContext, _invocation, context) {
      return { content: [{ type: "text", text: await run(context) }], details: undefined };
    },
  };
}

/**
 * A tool that reports when it starts and finishes when the test opens the gate. Like every
 * well-behaved tool it honours its context's signal: Pi's `abort()` waits for running tools.
 */
export function gateTool(name: string): {
  tool: AgentHarnessTool<undefined>;
  started: Promise<PiContext>;
  open(result: string): void;
} {
  let started!: (context: PiContext) => void;
  let open!: (result: string) => void;
  const startedPromise = new Promise<PiContext>((resolve) => (started = resolve));
  const opened = new Promise<string>((resolve) => (open = resolve));
  return {
    tool: tool(name, (context) => {
      started(context);
      const signal = context.abortSignal;
      if (signal === undefined) return opened;
      return new Promise<string>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void opened.then(resolve);
      });
    }),
    started: startedPromise,
    open,
  };
}
