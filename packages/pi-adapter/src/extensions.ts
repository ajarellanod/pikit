/**
 * @pikit/pi-adapter/extensions: what a component writes agent behaviour with. An agent extension is
 * pi-durable's own (`defineExtension`): system prompt `sections` (async; they see the resolved agent,
 * the environment and the conversation's committed documents), `hooks` on the built-in tasks
 * (`hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })`,
 * `hook(ToolTask, { beforeTool, afterTool })`, `hook(CompactionTask, { beforeCompact })`), `wraps`
 * (`wrapTool`, `wrapSection`), durable `tasks` (`defineTask`) and `tools` (`defineTool`). Its state is
 * a document (`defineDoc`, with its `checkpointWhen`), committed with the transcript, or the app's
 * `storage.sql`.
 *
 * `afterTool` sees every result a tool task writes, also those pi-durable writes for a call that never
 * ran or was cut off (`blocked`, `invalid_arguments`, `tool_unavailable`, `interrupted`,
 * `restart_limit`, `aborted`, `abandoned`: the code of its `result.diagnostics`). A hook that assumes
 * the tool ran (casts `call.arguments`, reads `structuredOutput`) checks the diagnostics first.
 *
 * A component provides one under its name, and agents run with it by naming it:
 *
 *   pikit.provideKeyed("agent.extension", "memory", defineExtension({ name: "memory", sections: [...] }));
 *   defineAgent({ name: "assistant", model: "anthropic/claude-sonnet-4-5", extensions: ["memory"] });
 *
 * Its tools, sections and hooks run, like every tool of an agent, with `CONVERSATION`, `AGENT_STATE`
 * and `RUN_REQUESTS` in their context (`originOf(CONVERSATION)` for the person behind a delegated
 * task). The conversation's record is also its `ConversationDoc`
 * (`input.read.snapshot(ConversationDoc, input.conversationId, context)`).
 *
 * An extension may choose, per conversation, which of its tools the model is offered:
 *
 *   offerTools(defineExtension({ name: "memory", tools: [remember, projectNote] }), async (conversation, ctx) =>
 *     (await isProject(spaceOf(conversation), ctx)) ? ["project_note"] : ["remember"]);
 *
 * The runtime asks at each admission of a message (before its commit: it may call other actors) and
 * keeps the answer with the conversation (`ConversationDoc.offered`), so a restart, a state update or a
 * reopened Harness offers the same until the next admission. A tool not offered is not sent to the
 * model, and a call to it by name is refused (`tool_unavailable`, the tool never runs); nested calls
 * (`executeTool`) do not find it either. `undefined` offers every tool of the extension. A failure (a
 * throw, a rejection, a wrong answer, `OFFER_TIMEOUT_MS`) keeps the conversation's last answer, or
 * offers none of the extension's tools when there is none: closed, so a store that cannot be reached
 * never shows a family of tools the extension meant to hide. Keep a tool's own refusal outside its
 * family's spaces as a second line (an answer changes from the next admission, not mid-run).
 *
 * Neutral: it runs on every target.
 */

export {
  CompactionTask,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  GenerationTask,
  hook,
  section,
  ToolTask,
  wrapSection,
  wrapTool,
} from "@earendil-works/pi-durable";
export type { Extension, PromptInput, PromptSection, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
export { ConversationDoc, OFFER_TIMEOUT_MS, offerTools } from "./agent.ts";
export type { Offers, ToolOffer } from "./agent.ts";
