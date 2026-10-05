/**
 * admin-api: the operator's HTTP API (SPEC §5), what the dashboard reads and does, and the dashboard's
 * built files. The routes are in `routes.ts`, their JSON in `api.ts`.
 *
 * - **Every API answer asks `admin.auth`** first: no operator, `401`. The dashboard's files hold no
 *   data and are served to anyone (`assets.ts`): a browser's navigation sends no header. They are a
 *   module the dashboard's own build writes (`dashboard-files.ts`), bundled with the app: no disk.
 * - **It reads contracts, never internals:** the composition from `APP_DESCRIPTION` (K13), the runtime
 *   from `agent.observe`. Nothing it reads changes anything.
 * - **Every action goes through the contract that owns it:** a message through `agent.runtime`'s
 *   `dispatch` (a steer by default), an abort through its `abort`, a reset through
 *   `conversations.registry`'s `reset`. Each is logged with the operator's id and the conversation,
 *   never the message's text.
 * - **Delivery, when an `outbound.queue` is installed:** the pieces not delivered yet (`pending`) and
 *   those that settled (`receipts`, read after a cursor), as the queue keeps them; never their text.
 * - **Only a conversation's current one is talked to.** A message, an abort or a reset to a
 *   conversation a reset left behind is `409 not_current`.
 * - **A message from the dashboard is part of the conversation.** Its run's answer goes where the
 *   conversation's other answers go (the chat of its channel), as any message's does.
 *
 * Targets: `server` and `durable`.
 * - **On a server** this export is the whole API, over the App's own contracts (`createLocalBackend`):
 *   every conversation, live events from `agent.observe`'s `watch`.
 * - **On Cloudflare** it goes in each conversation's Durable Object (the default App), and the routes
 *   are the Worker's half's (`worker.ts`, `export const worker`). Here it answers the Worker's calls
 *   about this object's conversations (`calls.ts`), and tells the index (`conversation-index.ts`, the
 *   object `admin-api:index`) when a run starts and settles. Its routes are registered in the object's
 *   App too, where no server serves them. The index object runs this same App and answers the
 *   Worker's list: nothing here makes a conversation for it.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import type { ConversationRef } from "@pikit/contracts";
import { createAssets } from "./assets.ts";
import { createLocalBackend } from "./backend.ts";
import { answerCalls, SEEN } from "./calls.ts";
import { Config } from "./config.ts";
import { createConversationIndex, INDEX_KEY } from "./conversation-index.ts";
import { DASHBOARD_FILES } from "./dashboard-files.ts";
import { provideRoutes } from "./routes.ts";

export { worker, WORKER_NAME } from "./worker.ts";

export default defineComponent({
  name: "admin-api",
  config: Config,
  setup(pikit, config) {
    const auth = pikit.use("admin.auth");
    const observe = pikit.use("agent.observe");
    const runtime = pikit.use("agent.runtime");
    const registry = pikit.use("conversations.registry");
    // Delivery: shown when an outbound queue is installed.
    const queue = pikit.useOptional("outbound.queue");
    // On Cloudflare (`durable`): the Worker's calls, the index's messages, and the index's own SQL.
    const inbox = pikit.useOptional("actor.inbox");
    const mailbox = pikit.useOptional("actor.mailbox");
    const sql = pikit.useOptional("storage.sql");
    const assets = createAssets(DASHBOARD_FILES);
    const backend = createLocalBackend({ observe: () => observe.get(), runtime: () => runtime.get(), registry: () => registry.get() });

    provideRoutes(pikit, {
      auth,
      backend: () => backend,
      queue: () => queue.get(),
      noQueue: "no outbound.queue is installed: answers go straight to their platform, with nothing to show here",
      heartbeatMs: config.heartbeatMs,
      assets,
    });

    /** Tells the index this conversation's key is active (`durable` only). Missed, the next run tells it again. */
    const seen = async (conversation: ConversationRef, ctx: AppContext): Promise<void> => {
      if (pikit.target !== "durable") return;
      const send = mailbox.get();
      if (send === undefined) return;
      try {
        await send.send(INDEX_KEY, SEEN, { key: conversation.key, agent: conversation.agent, at: ctx.clock.now() }, ctx);
      } catch (error) {
        ctx.logger.warn("admin-api: the conversation index did not take this conversation's activity; its next run tells it again", {
          conversation: conversation.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    pikit.on("agent.started", (event, ctx) => seen(event.conversation, ctx));
    pikit.on("agent.settled", (result, ctx) => seen(result.conversation, ctx));

    return {
      start(ctx) {
        if (pikit.target !== "durable") {
          if (assets.built()) ctx.logger.info("admin-api: the dashboard is served at /admin/", { files: assets.size() });
          else ctx.logger.info("admin-api: no dashboard is built; the API alone is served at /admin/api/");
          return;
        }
        const calls = inbox.get();
        const database = sql.get();
        const missing = [calls === undefined && "actor.inbox", mailbox.get() === undefined && "actor.mailbox", database === undefined && "storage.sql"].filter(Boolean);
        if (calls === undefined || database === undefined || missing.length > 0) {
          throw new Error(
            `admin-api: in a Durable Object's App it answers the Worker's calls and keeps the conversation index, which needs ${missing.join(", ")}: install platform-cloudflare and storage-do`,
          );
        }
        answerCalls(calls, backend, createConversationIndex(() => database));
      },
    };
  },
});
