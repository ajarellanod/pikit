/**
 * admin-api: the operator's HTTP API (SPEC §5), what the dashboard reads and does, and the dashboard's
 * built files. The routes are in `routes.ts`, their JSON in `api.ts`.
 *
 * - **Every API answer asks `admin.auth`** first: no operator, `401`. The dashboard's files hold no
 *   data and are served to anyone (`assets.ts`), under a Content-Security-Policy. They are a module the
 *   dashboard's own build writes (`dashboard-files.ts`), bundled with the app: no disk.
 * - **It reads contracts, never internals:** the composition from `APP_DESCRIPTION` (K13, config
 *   values that look like secrets redacted), the runtime from `agent.observe`. Nothing it reads
 *   changes anything.
 * - **The dashboard is a channel of its own.** It reads every conversation; it writes only into its
 *   own (`dashboard:<uuid>`, with an agent of the App) and, into another channel's, as a follow-up
 *   (never a steer) whose request id starts with `dashboard:`: a run only such messages started is
 *   never delivered to that channel (`startAnswerDelivery`), and the agent reads that the message is
 *   the operator's (`operatorPrompt`). Abort and reset stay on every conversation.
 * - **Every action goes through the contract that owns it:** a message through `agent.runtime`'s
 *   `dispatch`, a new conversation through `conversations.registry`'s `resolve`, an abort through
 *   `agent.runtime`'s `abort`, a reset through `conversations.registry`'s `reset`. Each is logged with
 *   the operator's id and the conversation, never the message's text.
 * - **The list is newest activity first**, paged, from the conversation index (`conversation-index.ts`)
 *   that this component keeps from the runtime's events (a message dispatched, a run started, settled
 *   or failed, a reset) and, when the App starts, from what `agent.observe` holds.
 * - **Delivery, when an `outbound.queue` is installed:** the pieces not delivered yet (`pending`) and
 *   those that settled (`receipts`, read after a cursor), as the queue keeps them; never their text.
 * - **Only a conversation's current one is talked to.** A message, an abort or a reset to a
 *   conversation a reset left behind is `409 not_current`. A reset's new conversation is its key's
 *   current one, with the key's agent, before any message reaches it: it is talked to at once.
 *
 * Targets: `server` and `durable`.
 * - **On a server** this export is the whole API, over the App's own contracts (`createLocalBackend`):
 *   every conversation, live events from `agent.observe`'s `watch`; the index is a table of the App's
 *   `storage.sql`, filled at start in the background from every conversation the runtime holds.
 * - **On Cloudflare** it goes in each conversation's Durable Object (the default App), and the routes
 *   are the Worker's half's (`worker.ts`, `export const worker`). Here it answers the Worker's calls
 *   about this object's conversations (`calls.ts`), and tells the index (the object `admin-api:index`)
 *   of their activity: when a message is dispatched, a resumed run starts, a run settles or fails, a
 *   reset, and when the object's App starts (its conversations, from `agent.observe`). Its routes are
 *   registered in the object's App too, where no server serves them. The index object runs this same
 *   App and answers the Worker's list: nothing here makes a conversation for it.
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent, withAbortSignal } from "@pikit/core";
import type { AgentObserver, ConversationRef } from "@pikit/contracts";
import { createAssets } from "./assets.ts";
import { createLocalBackend } from "./backend.ts";
import { answerCalls, SEEN } from "./calls.ts";
import { Config } from "./config.ts";
import { createConversationIndex, INDEX_KEY, type IndexedConversation } from "./conversation-index.ts";
import { DASHBOARD_FILES } from "./dashboard-files.ts";
import { provideRoutes } from "./routes.ts";

export { worker, WORKER_NAME } from "./worker.ts";

/** Conversations read from `agent.observe` per page when the App starts, and sent to the index at once. */
const BACKFILL_PAGE = 100;

export default defineComponent({
  name: "admin-api",
  config: Config,
  setup(pikit, config) {
    const auth = pikit.use("admin.auth");
    const observe = pikit.use("agent.observe");
    const runtime = pikit.use("agent.runtime");
    const registry = pikit.use("conversations.registry");
    // The conversation index: the App's own table on a server; on Cloudflare the index object's.
    const sql = pikit.use("storage.sql");
    // Delivery: shown when an outbound queue is installed.
    const queue = pikit.useOptional("outbound.queue");
    // On Cloudflare (`durable`): the Worker's calls, and the index's messages.
    const inbox = pikit.useOptional("actor.inbox");
    const mailbox = pikit.useOptional("actor.mailbox");
    const durable = pikit.target === "durable";
    const assets = createAssets(DASHBOARD_FILES);
    const index = createConversationIndex(() => sql.get());
    const contracts = { observe: () => observe.get(), runtime: () => runtime.get(), registry: () => registry.get(), index: () => index };
    // A server's: a conversation no message reached yet is its key's by the index's row (a reset's new one).
    const backend = createLocalBackend({ ...contracts, keyOf: (conversationId) => index.keyOf(conversationId) });

    provideRoutes(pikit, {
      auth,
      backend: () => backend,
      queue: () => queue.get(),
      noQueue: "no outbound.queue is installed: answers go straight to their platform, with nothing to show here",
      heartbeatMs: config.heartbeatMs,
      assets,
    });

    /**
     * Records activity in the index: the App's own on a server, the index object's on Cloudflare (a
     * message). Missed, the next activity or the App's next start records it again.
     */
    const seen = async (entries: IndexedConversation[], ctx: AppContext): Promise<void> => {
      if (entries.length === 0) return;
      try {
        if (!durable) return await index.seen(entries);
        const send = mailbox.get();
        if (send !== undefined) await send.send(INDEX_KEY, SEEN, { entries: entries.map((entry) => ({ ...entry })) }, ctx);
      } catch (error) {
        ctx.logger.warn("admin-api: the conversation index did not take this conversation's activity; its next activity tells it again", {
          conversation: entries[0]?.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    const active = (conversation: ConversationRef, ctx: AppContext) =>
      seen([{ key: conversation.key, conversationId: conversation.conversationId, agent: conversation.agent, at: ctx.clock.now() }], ctx);

    // In the caller's context, once the message is durable: the most reliable moment.
    pikit.on("agent.dispatched", ({ conversation, admission }, ctx) => (admission.kind === "duplicate" ? undefined : active(conversation, ctx)));
    // On Cloudflare a run that is not resumed was dispatched in this object just before: one message fewer.
    pikit.on("agent.started", ({ conversation, resumed }, ctx) => (durable && !resumed ? undefined : active(conversation, ctx)));
    pikit.on("agent.settled", (result, ctx) => active(result.conversation, ctx));
    pikit.on("agent.failed", (result, ctx) => active(result.conversation, ctx));
    pikit.on("conversation.reset", ({ conversation }, ctx) => active(conversation, ctx));

    /** Every conversation `observer` holds with a key, a page at a time, into the index: what events may have missed. */
    const backfill = async (observer: AgentObserver, ctx: AppContext): Promise<number> => {
      let cursor: string | undefined;
      let count = 0;
      do {
        if (ctx.abortSignal?.aborted === true) break;
        const page = await observer.conversations({ limit: BACKFILL_PAGE, ...(cursor !== undefined && { cursor }) }, ctx);
        const entries = page.items.flatMap(({ key, agent, conversationId, lastActivity }) =>
          key === undefined || agent === undefined ? [] : [{ key, agent, conversationId, at: lastActivity ?? 0 }],
        );
        await seen(entries, ctx);
        count += entries.length;
        cursor = page.next;
      } while (cursor !== undefined);
      return count;
    };

    let stopping: AbortController | undefined;
    let filling: Promise<void> | undefined;

    return {
      async start(ctx) {
        if (!durable) {
          if (assets.built()) ctx.logger.info("admin-api: the dashboard is served at /admin/", { files: assets.size() });
          else ctx.logger.info("admin-api: no dashboard is built; the API alone is served at /admin/api/");
          // In the background: a server with thousands of conversations starts at once.
          stopping = new AbortController();
          const background = ctx.derive(() => withAbortSignal((stopping as AbortController).signal, BACKGROUND_CONTEXT));
          filling = backfill(observe.get(), background).then(
            (count) => ctx.logger.info("admin-api: the conversation index has every conversation of the runtime", { conversations: count }),
            (error: unknown) => ctx.logger.warn("admin-api: the conversation index was not filled from the runtime; events keep it", { error: error instanceof Error ? error.message : String(error) }),
          );
          return;
        }
        const calls = inbox.get();
        const missing = [calls === undefined && "actor.inbox", mailbox.get() === undefined && "actor.mailbox"].filter(Boolean);
        if (calls === undefined || missing.length > 0) {
          throw new Error(`admin-api: in a Durable Object's App it answers the Worker's calls and tells the conversation index, which needs ${missing.join(", ")}: install platform-cloudflare`);
        }
        // An object's conversations are all of its key.
        answerCalls(calls, (key) => createLocalBackend({ ...contracts, keyOf: async () => key }), index);
        // This object's conversations (a few): the index learns of them even if their events were missed.
        await backfill(observe.get(), ctx).catch((error: unknown) =>
          ctx.logger.warn("admin-api: this object's conversations were not told to the index", { error: error instanceof Error ? error.message : String(error) }),
        );
      },
      async stop() {
        stopping?.abort();
        await filling;
      },
    };
  },
});
