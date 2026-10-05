/**
 * provider-faux: fake models, for tests and trials only. No network, no key, no cost; every answer
 * is computed from the request, at once. It provides the keyed capability `model.provider` under the
 * key `faux`, with two models:
 *
 * - `faux/echo` answers every turn with `faux: <the newest user message>`.
 * - `faux/scripted` follows what the newest message says (`scriptedReply`):
 *   - `call: <tool> <json arguments>` calls that tool with those arguments (`{}` when none are given);
 *     the turn after its result answers `<tool>: <result text>`, or `<tool> failed: <error text>`;
 *   - `echo-system` answers with the system prompt it was sent: its instructions, then every section
 *     as it stands; `echo-system <section>` answers with that section only, or `(no section <section>)`;
 *   - `echo-tools` answers with the names of the tools it was offered, sorted, or `(no tools)`;
 *   - anything else is answered as `faux/echo` does.
 *
 * What it is for: an end-to-end test of a project (a real channel, runtime and delivery) without a
 * model account, and a test of your own tool or agent extension through runtime-pi: `call:` makes the
 * model call your tool, `echo-system` shows what your extension put in the prompt. pikit's own e2e
 * installs it. Never in production: an agent on a `faux/*` model answers nobody usefully. Remove it
 * with `pikit remove provider-faux` once the test is done, or keep it in a test-only composition.
 *
 * The models are pi-ai 1.0's faux provider (`@pikit/pi-adapter/providers/faux`), scripted here: each
 * answer is computed from the request, and the next one is queued as it is taken, so it never runs out.
 *
 * Targets: `server` and `durable`: it imports nothing platform-specific.
 */

import { defineComponent } from "@pikit/core";
import type { Provider } from "@pikit/pi-adapter";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@pikit/pi-adapter/providers/faux";

/** The provider's id: agents name its models `faux/echo` and `faux/scripted`. */
export const FAUX_PROVIDER = "faux";
/** The model that echoes. */
export const FAUX_MODEL = "echo";
/** The model that follows the grammar above. */
export const SCRIPTED_MODEL = "scripted";

/** What `faux/echo` answers to `text`, the newest user message. */
export function fauxAnswer(text: string): string {
  return `faux: ${text}`;
}

type Message = Parameters<FauxResponseFactory>[0]["messages"][number];

/** What `faux/scripted` does next: call a tool, or answer a text. */
export type ScriptedReply = { call: string; arguments: ToolArguments } | { text: string };

/** A tool call's arguments: a JSON object. */
type ToolArguments = Parameters<typeof fauxToolCall>[1];

/** A message's text (its text parts, joined); a system message's is its instructions. */
function textOf(message: Message | undefined): string {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * The system prompt as it stands after `messages`: each system message adds instructions, replaces
 * or removes (`null`) sections by name, and adds or removes tools, in order.
 */
export function systemPrompt(messages: readonly Message[]): { instructions: string[]; sections: Map<string, string>; tools: string[] } {
  const instructions: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Set<string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    const text = textOf(message);
    if (text !== "") instructions.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return { instructions, sections, tools: [...tools].sort() };
}

/** What `faux/scripted` replies to a request's messages (the grammar above). */
export function scriptedReply(messages: readonly Message[]): ScriptedReply {
  const newest = [...messages].reverse().find((message) => message.role !== "system");
  if (newest?.role === "toolResult") return { text: `${newest.toolName}${newest.isError ? " failed" : ""}: ${textOf(newest)}` };
  const text = newest?.role === "user" ? textOf(newest).trim() : "";
  const call = /^call:\s*(\S+)(?:\s+(.+))?$/s.exec(text);
  if (call?.[1] !== undefined) {
    let args: unknown;
    try {
      args = JSON.parse(call[2] ?? "{}");
    } catch {
      return { text: `faux/scripted: the arguments of ${call[1]} are not JSON: ${call[2]}` };
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) return { text: `faux/scripted: the arguments of ${call[1]} are not a JSON object: ${call[2]}` };
    return { call: call[1], arguments: args as ToolArguments };
  }
  const echo = /^echo-system(?:\s+(\S+))?$/.exec(text);
  if (echo !== null) {
    const prompt = systemPrompt(messages);
    const name = echo[1];
    if (name !== undefined) return { text: prompt.sections.get(name) ?? `(no section ${name})` };
    return { text: [...prompt.instructions, ...prompt.sections.values()].join("\n\n") };
  }
  if (text === "echo-tools") {
    const { tools } = systemPrompt(messages);
    return { text: tools.length > 0 ? tools.join(", ") : "(no tools)" };
  }
  return { text: fauxAnswer(text) };
}

/** The faux provider: `faux/echo` and `faux/scripted`. */
export function createFauxProvider(): Provider {
  const faux = fauxProvider({
    provider: FAUX_PROVIDER,
    models: [
      { id: FAUX_MODEL, name: "Echo (tests only)" },
      { id: SCRIPTED_MODEL, name: "Scripted (tests only)" },
    ],
  });
  const answer: FauxResponseFactory = (context, _options, _state, model) => {
    // Queue the next answer as this one is taken: the script never runs out.
    faux.appendResponses([answer]);
    if (model.id === SCRIPTED_MODEL) {
      const reply = scriptedReply(context.messages);
      if ("call" in reply) return fauxAssistantMessage(fauxToolCall(reply.call, reply.arguments), { stopReason: "toolUse" });
      return fauxAssistantMessage(reply.text);
    }
    const newest = [...context.messages].reverse().find((message) => message.role === "user");
    return fauxAssistantMessage(fauxAnswer(textOf(newest)));
  };
  faux.setResponses([answer]);
  return faux.provider;
}

export default defineComponent({
  name: "provider-faux",
  setup(pikit) {
    const provider = createFauxProvider();
    pikit.provideKeyed("model.provider", provider.id, provider);
  },
});
