/**
 * admin-api: the operator's HTTP API (SPEC §5), what the dashboard reads and does, and the dashboard's
 * built files. The routes are in `routes.ts`, their JSON in `api.ts`.
 *
 * - **Every API answer asks `admin.auth`** first: no operator, `401`. The dashboard's files hold no
 *   data and are served to anyone (`assets.ts`), under a Content-Security-Policy. They are a module the
 *   dashboard's own build writes (`dashboard-files.ts`), bundled with the app: no disk.
 * - **It reads contracts, never internals:** the composition from `APP_DESCRIPTION` (K13, config
 *   values that look like secrets redacted), the agents from `agent.definition` (name, model, the
 *   names of their tools) and the live ones from `agent.directory` when installed (agents-live, made
 *   in the dashboard), the runtime from `agent.observe`. Nothing it reads changes anything.
 * - **The list of conversations is a view of the directory** (`conversations.directory`), as an
 *   operator sees it (`{ kind: "operator", id }`): every conversation, the most recently active first,
 *   one title whoever looks; each one's conversation is then read where it is, for what the directory
 *   does not hold (busy, usage, who it is with). admin-api keeps no index and titles nothing: the
 *   directory's provider records the runtime's events and has a model title each conversation.
 * - **For everyone, and for me** (the directory's, honoured by every view): a rename (`rename`, `/name`);
 *   "Archive for everyone" (back with new activity people see) and "Delete for everyone" (for good;
 *   the key's next message starts a new conversation), and back; "Hide for me", this operator's own
 *   list only, until new activity. Nothing of the runtime's is deleted.
 * - **The dashboard is a channel of its own.** It reads every conversation; it writes only into its
 *   own (`dashboard:<uuid>`, with an agent of the App, owned by its operator, whose first message is
 *   its first title) and, into another channel's, as a follow-up (never a steer) whose request id
 *   starts with `dashboard:`: a run only such messages started is never delivered to that channel
 *   (`startAnswerDelivery`), and the agent reads that the message is the operator's
 *   (`operatorPrompt`). Abort and reset stay on every conversation.
 * - **Every action goes through the contract that owns it:** a message through `agent.runtime`'s
 *   `dispatch`, a new conversation through `conversations.registry`'s `resolve`, an abort through
 *   `agent.runtime`'s `abort`, a reset through `conversations.registry`'s `reset`, a title or a state
 *   through `conversations.directory`. Each is logged with the operator's id and the conversation,
 *   never the message's text.
 * - **Delivery, when an `outbound.queue` is installed:** the pieces not delivered yet (`pending`) and
 *   those that settled (`receipts`, read after a cursor), as the queue keeps them, each with the
 *   conversation it answers; never their text.
 * - **Slash commands** are the App's `agent.command`s, listed and run in a conversation (as an action:
 *   its key's current one) by `runAgentCommand`. admin-api registers two of Pi's built-ins, through the
 *   same capability: `/new` (Pi's "Start a new session": the key's reset, `conversations.registry`'s
 *   `reset`) and `/name <title>` (the conversation's title for everyone: the directory's `rename`, as
 *   trusted code). runtime-pi registers `/compact`; a component of yours registers its own.
 * - **Who each conversation is with** (`ApiConversation.party`, `party.ts`): its channel's stage of
 *   the `conversation.describe` pipeline (read and cleaned by `describeConversation`), else what its
 *   key says; the dashboard's own are the operator's. A pipeline, so admin-api depends on no channel.
 *   Asked where the conversation is: on Cloudflare in its object, where the channel's object half is.
 * - **Only a conversation's current one is talked to.** A message, an abort or a reset to a
 *   conversation a reset left behind is `409 not_current`. A reset's new conversation is its key's
 *   current one, with the key's agent, before any message reaches it: it is talked to at once.
 *
 * Targets: `server` and `durable`. It never reads the target: in `start`, `actor.inbox`'s `scope` says
 * where the routes are served from.
 * - **On a server** (`"all"`, or no `actor.inbox`) this export is the whole API, over the App's own
 *   contracts and its directory (`createAdminBackend` over `createLocalHost`): live events from
 *   `agent.observe`'s `watch`.
 * - **On Cloudflare** (`"one"`) it goes in each conversation's Durable Object (the default App), and the
 *   routes are the Worker's half's (`worker.ts`, `export const worker`), which asks the directory itself.
 *   Here it answers the Worker's calls about this object's conversations (`calls.ts`). Its routes are
 *   registered in the object's App too, where no server serves them.
 */

import { defineComponent } from "@pikit/core";
import { type AgentCommand, cleanTitle, DIRECTORY_PAGE_MAX, DirectoryError, isCommandName } from "@pikit/contracts";
import type { ApiAgent } from "./api.ts";
import { createAssets } from "./assets.ts";
import { createAdminBackend } from "./backend.ts";
import { answerCalls } from "./calls.ts";
import { Config } from "./config.ts";
import { DASHBOARD_FILES } from "./dashboard-files.ts";
import { agentOf, createLocalHost, summariesOf } from "./host.ts";
import { provideRoutes } from "./routes.ts";

export { worker, WORKER_NAME } from "./worker.ts";

/** Who `/name` renames as: trusted code (the command runs for an operator, or a channel that titles its own). */
const NAME_VIEWER = { kind: "component", name: "admin-api" } as const;

export default defineComponent({
  name: "admin-api",
  config: Config,
  setup(pikit, config) {
    const auth = pikit.use("admin.auth");
    const observe = pikit.use("agent.observe");
    const runtime = pikit.use("agent.runtime");
    const registry = pikit.use("conversations.registry");
    // The list, titles and states: one directory for every view.
    const conversations = pikit.use("conversations.directory");
    // Delivery: shown when an outbound queue is installed.
    const queue = pikit.useOptional("outbound.queue");
    // Whose actor this App is (`scope`); where it is one key's, the Worker's calls.
    const inbox = pikit.useOptional("actor.inbox");
    // The agents, for `GET /admin/api/agents` and a web search asked of one.
    const definitions = pikit.useKeyed("agent.definition");
    // The live agents, made in the dashboard (agents-live), listed after the code's.
    const liveAgents = pikit.useOptional("agent.directory");
    // The tools and skills agents may have, each with its one line: what the Agent sections show.
    const tools = pikit.useKeyed("agent.tool");
    const skills = pikit.useKeyed("agent.skill");
    // The slash commands the dashboard lists and runs: its own two below, runtime-pi's, yours.
    const commands = pikit.useKeyed("agent.command");
    const assets = createAssets(DASHBOARD_FILES);
    const host = createLocalHost({
      observe: () => observe.get(),
      runtime: () => runtime.get(),
      registry: () => registry.get(),
      agents: async (ctx) => [
        ...definitions.keys().sort().map((name) => agentOf(name, definitions.get(name))),
        ...((await liveAgents.get()?.list(ctx)) ?? []).map((agent): ApiAgent => ({
          name: agent.name,
          live: true,
          ...(agent.description !== undefined && agent.description !== "" && { description: agent.description }),
          model: agent.model,
          tools: agent.tools ?? [],
          // A live agent is never the steward (agents-live refuses it).
          steward: false,
        })),
      ],
      commands: () => ({ keys: () => commands.keys().filter(isCommandName), get: (name: string) => commands.get(name) }),
      summaries: () =>
        summariesOf(
          { tools: tools.keys().map((name) => [name, tools.get(name)] as const), skills: skills.keys().map((name) => [name, skills.get(name)] as const) },
          definitions.keys().map((name) => definitions.get(name)),
        ),
    });
    const backend = createAdminBackend({ host: () => host, directory: () => conversations.get(), pageMax: DIRECTORY_PAGE_MAX });

    provideRoutes(pikit, {
      auth,
      backend: () => backend,
      queue: () => queue.get(),
      noQueue: "no outbound.queue is installed: answers go straight to their platform, with nothing to show here",
      heartbeatMs: config.heartbeatMs,
      assets,
    });

    // Pi's built-ins pikit does for real, registered as any component's are.
    const newConversation: AgentCommand = {
      description: "Start a new conversation: this one is kept, and its key starts again empty",
      audience: "operator",
      async run(conversation, _args, ctx) {
        const reset = await registry.get().reset(conversation.key, undefined, ctx);
        if (reset === undefined) throw new Error("this conversation's key points to no conversation");
        return { text: "A new conversation started; the previous one is kept, and can be read." };
      },
    };
    const nameCommand: AgentCommand = {
      description: "Set the conversation's title",
      audience: "operator",
      argumentHint: "<title>",
      async run(conversation, args, ctx) {
        if (cleanTitle(args) === undefined) throw new Error("Write the title after the command: /name <title>");
        try {
          const { title } = await conversations.get().rename(NAME_VIEWER, { key: conversation.key, conversationId: conversation.conversationId }, args, ctx);
          return { text: `Titled “${title ?? args.trim()}”.` };
        } catch (error) {
          if (error instanceof DirectoryError && error.code === "not_found") throw new Error("The conversation directory does not hold this conversation yet: it does once a message reaches it");
          throw error;
        }
      },
    };
    pikit.provideKeyed("agent.command", "new", newConversation);
    pikit.provideKeyed("agent.command", "name", nameCommand);

    return {
      start(ctx) {
        const calls = inbox.get();
        // One key's actor (a Durable Object): the Worker serves the routes, this App answers its calls.
        if (calls !== undefined && calls.scope === "one") {
          answerCalls(calls, host);
          return;
        }
        if (assets.built()) ctx.logger.info("admin-api: the dashboard is served at /admin/", { files: assets.size() });
        else ctx.logger.info("admin-api: no dashboard is built; the API alone is served at /admin/api/");
      },
    };
  },
});
