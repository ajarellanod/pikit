/**
 * conversations-directory: `conversations.directory` (`@pikit/contracts`' conversation-directory.ts),
 * one directory of the conversations every view lists (features/conversation-directory.md).
 *
 * - **The directory** (`directory.ts`): one row per conversation (its key, runtime conversation,
 *   channel, agent, space, owner, one title, created and last active, busy, its state for everyone),
 *   each viewer's own state (hidden for me, read up to, a name of their own), and each conversation's
 *   newest activity (who, when, whether people see it) for `unread`.
 * - **The recorder** (`recorder.ts`), in each conversation's App, from the runtime's events and, at
 *   start, `agent.observe` (K3); the place read from `conversations.registry` when it first sees a key.
 * - **The titler** (`titles.ts`), in each conversation's App, in a wakeup: a model's title once,
 *   through `model.complete` when installed.
 * - **The client** (`client.ts`): the contract's checks, a people viewer's grants computed in the
 *   calling App (`audienceGrants`, the `conversation.audience` pipeline), and the directory's answer.
 *
 * Targets: `server` and `durable`. It never reads the target: in `start`, `actor.inbox`'s `scope`
 * says where the directory is.
 * - **Every key's actor** (`"all"`, or no `actor.inbox`: a server): every table is this App's
 *   `storage.sql`; the recorder writes the directory at once; the backfill runs in the background; the
 *   titler runs in `wakeups` when installed, else in the background, waited for at stop.
 * - **One key's actor** (`"one"`: a Durable Object): the directory is the object
 *   `conversations-directory:index` (`INDEX_KEY`), an object of the conversations' class that runs this
 *   same App; each conversation's object keeps `_outbox` and `_titles` and sends the outbox in a wakeup
 *   (`conversations-directory.flush`): one `seen` per flush, none on a message's path. Every directory
 *   call is an `actor.mailbox.call` to the index object (`calls.ts`). Deleting a key's current
 *   conversation for everyone resets the key in its own object (`conversations-directory.reset`). It
 *   needs `actor.mailbox` and `wakeups` there (actors-do): it refuses to start without them. The Worker's
 *   App has the Worker half (`worker.ts`).
 *
 * Config: `titleModel` (the model that titles; absent, each conversation's agent's) and
 * `retitleAtStart` (how many conversations the start's backfill found are titled at one start).
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent, withAbortSignal } from "@pikit/core";
import type { ActorMailbox, Wakeups } from "@pikit/contracts";
import { answerCalls } from "./calls.ts";
import { type Backend, CALL, directoryOver, localBackend, remoteBackend } from "./client.ts";
import { Config } from "./config.ts";
import { createDirectoryStore } from "./directory.ts";
import { createRecorder, directSink, FLUSH, flush, outboxSink, pending, resetUpdates, type Sink } from "./recorder.ts";
import { directoryTables, localTables } from "./tables.ts";
import { createTitler } from "./titles.ts";
import { parseUpdate, sequencer, type Update } from "./update.ts";

export { CALL, INDEX_KEY, SEEN } from "./client.ts";
export { FLUSH } from "./recorder.ts";
export { ACTIVITY, ENTRIES, OUTBOX, TITLES, VIEWERS } from "./tables.ts";
export { worker } from "./worker.ts";

/** The wakeup that titles conversations. */
export const TITLE = "conversations-directory.title";
/** Who the directory's own reads are by (the titler's): a component. */
const SELF = { kind: "component", name: "conversations-directory" } as const;

export default defineComponent({
  name: "conversations-directory",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const registry = pikit.use("conversations.registry");
    // The start's backfill (K3), and a conversation's first user text for its title.
    const observe = pikit.use("agent.observe");
    // Whose actor this App is (`scope`); on Cloudflare the directory's calls and messages, and the outbox's wakeup.
    const inbox = pikit.useOptional("actor.inbox");
    const mailbox = pikit.useOptional("actor.mailbox");
    const wakeups = pikit.useOptional("wakeups");
    // Titles: a model's text, through the runtime's models, with each agent's model unless `titleModel`.
    const completion = pikit.useOptional("model.complete");
    const definitions = pikit.useKeyed("agent.definition");
    const now = () => pikit.clock.now();
    const seq = sequencer(now);
    const directoryDb = directoryTables(() => sql.get());
    const local = localTables(() => sql.get());

    let running: { backend: Backend; sink: Sink; send?: ActorMailbox; wake?: Wakeups } | undefined;
    const opened = () => {
      if (running === undefined) throw new Error("conversations-directory: used while the app is not running; use it from start or later");
      return running;
    };

    /** In the key's own App: resets `key` when `conversationId` is still its current one (a delete for everyone). */
    const resetHere = async (key: string, conversationId: string, ctx: AppContext): Promise<Update[]> => {
      const current = await registry.get().get(key, ctx);
      if (current === undefined) return [];
      if (current.conversationId !== conversationId) return [{ key, conversationId, seq: seq(), current: false }];
      const reset = await registry.get().reset(key, undefined, ctx);
      return reset === undefined ? [] : resetUpdates(reset.conversation, reset.previousConversationId, seq, now());
    };

    const store = createDirectoryStore({
      db: directoryDb,
      now,
      async reset(key, conversationId, ctx) {
        const { send } = opened();
        // A server's directory is in the key's App; on Cloudflare the key's object resets it.
        if (send === undefined) return resetHere(key, conversationId, ctx);
        const answer = (await send.call(key, CALL.reset, { conversationId }, ctx)) as { updates?: unknown };
        return Array.isArray(answer?.updates) ? answer.updates.map(parseUpdate) : [];
      },
    });

    const recorder = createRecorder({ sink: () => opened().sink, registry: () => registry.get(), observe: () => observe.get(), seq, now });

    /** Runs `run` in the background (a server with no `wakeups`), once at a time, again when asked during a run. */
    let background = BACKGROUND_CONTEXT;
    let titling: Promise<void> | undefined;
    let again = false;
    const titler = createTitler({
      local,
      complete: () => completion.get(),
      modelFor: (agent) => config.titleModel ?? definitions.get(agent)?.model,
      observe: () => observe.get(),
      entry: (ref, ctx) => directory.access(SELF, ref, ctx),
      write: (update, ctx) => opened().sink.write([update], ctx),
      seq,
      now,
      async kick(ctx) {
        const { wake } = opened();
        if (wake !== undefined) return wake.at(TITLE, now(), ctx);
        again = true;
        if (titling !== undefined) return;
        const runCtx = ctx.derive(() => background);
        titling = (async () => {
          while (again && runCtx.abortSignal?.aborted !== true) {
            again = false;
            await titler.run(runCtx).catch((error: unknown) => runCtx.logger.warn("conversations-directory: titling failed", { error: String(error) }));
          }
        })().finally(() => {
          titling = undefined;
        });
      },
    });

    const directory = directoryOver(() => opened().backend, {
      // A channel's first message, in the conversation's App: what its model title is made from.
      first: (ref, text) => titler.first(ref, text),
    });
    pikit.provide("conversations.directory", directory);

    pikit.on("agent.dispatched", (event, ctx) => recorder.dispatched(event, ctx));
    pikit.on("agent.started", (event, ctx) => recorder.started(event, ctx));
    pikit.on("agent.settled", async (result, ctx) => {
      await recorder.ended(result, ctx);
      await titler.settled(result, ctx);
    });
    pikit.on("agent.failed", (result, ctx) => recorder.ended(result, ctx));
    pikit.on("conversation.reset", (reset, ctx) => recorder.reset(reset, ctx));

    let stopping: AbortController | undefined;
    let filling: Promise<void> | undefined;

    /** The start's backfill, then titles for at most `retitleAtStart` of what it found, the most recently active first. */
    const fill = async (ctx: AppContext): Promise<void> => {
      const found = await recorder.backfill(ctx);
      const newest = [...found].sort((a, b) => b.at - a.at).slice(0, config.retitleAtStart);
      await titler.enqueue(newest, ctx);
      if (found.length > 0) ctx.logger.info("conversations-directory: the directory learned of conversations its events missed", { conversations: found.length });
    };

    return {
      async start(ctx) {
        stopping = new AbortController();
        background = withAbortSignal(stopping.signal, BACKGROUND_CONTEXT);
        const calls = inbox.get();
        const wake = wakeups.get();
        if (calls === undefined || calls.scope === "all") {
          running = { backend: localBackend(store), sink: directSink(store, directoryDb), ...(wake !== undefined && { wake }) };
          wake?.handle(TITLE, (wakeCtx) => titler.run(wakeCtx));
          // In the background: a server with thousands of conversations starts at once.
          const fillCtx = ctx.derive(() => background);
          filling = fill(fillCtx).catch((error: unknown) =>
            fillCtx.logger.warn("conversations-directory: the directory was not filled from the runtime; events keep it", { error: error instanceof Error ? error.message : String(error) }),
          );
          return;
        }
        const send = mailbox.get();
        if (send === undefined || wake === undefined) {
          throw new Error("conversations-directory: in an App that is one key's actor it tells the directory's actor through actor.mailbox, in a wakeup: it needs actor.mailbox and wakeups (actors-do)");
        }
        running = { backend: remoteBackend(() => send), sink: outboxSink(local, () => wake, now), send, wake };
        answerCalls(calls, { store, reset: resetHere });
        wake.handle(FLUSH, (wakeCtx) => flush(local, send, wake, now, wakeCtx));
        wake.handle(TITLE, (wakeCtx) => titler.run(wakeCtx));
        // K6: what the last App left in the outbox is sent again.
        if (await pending(local)) await wake.at(FLUSH, now(), ctx);
        // This object's conversations (a few): the directory learns of those whose events were missed.
        await fill(ctx).catch((error: unknown) =>
          ctx.logger.warn("conversations-directory: this object's conversations were not given to the directory", { error: error instanceof Error ? error.message : String(error) }),
        );
      },
      async stop() {
        stopping?.abort();
        await Promise.all([filling, titling]);
        running = undefined;
      },
    };
  },
});

