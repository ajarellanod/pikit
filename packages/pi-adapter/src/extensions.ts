/**
 * @pikit/pi-adapter/extensions: what a component writes agent behaviour with. An agent extension is
 * pi-durable's own (`defineExtension`): system prompt `sections` (async; they see the resolved agent,
 * the environment and the conversation's committed documents), `hooks` on the built-in tasks
 * (`hook(GenerationTask, { beforeRequest, afterResponse, onYield, afterTools })`,
 * `hook(ToolTask, { beforeTool, afterTool })`, `hook(CompactionTask, { beforeCompact })`), `wraps`
 * (`wrapTool`, `wrapSection`), durable `tasks` (`defineTask`) and `tools` (`defineTool`). Its state is
 * a document (`defineDoc`), committed with the transcript, or the app's `storage.sql`.
 *
 * A component provides one under its name, and agents run with it by naming it:
 *
 *   pikit.provideKeyed("agent.extension", "memory", defineExtension({ name: "memory", sections: [...] }));
 *   defineAgent({ name: "assistant", model: "anthropic/claude-sonnet-4-5", extensions: ["memory"] });
 *
 * Its tools run, like every tool of an agent, with `CONVERSATION` and `AGENT_STATE` in their context.
 * A section or a hook sees pi-durable's conversation id; the conversation's key and agent are its
 * `ConversationDoc` (`input.read.snapshot(ConversationDoc, input.conversationId, context)`).
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
export { ConversationDoc } from "./agent.ts";
