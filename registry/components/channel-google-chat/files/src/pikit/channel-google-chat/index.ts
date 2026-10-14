// Owner: skeleton. The default export: wiring, the choice by actor.inbox's scope, delivery, the run's events.
/**
 * channel-google-chat: talk to your agents in Google Chat, through a Chat app of your own built as a
 * Google Workspace add-on (features/channel-google-chat.md). Several apps are instances (`googlechat`,
 * `googlechat:ops`, instance.ts), each with its endpoint and secrets.
 *
 * **One code, both targets.** It never reads the target: in `start`, `actor.inbox`'s `scope` says where
 * it runs, as settings-store does.
 * - **A server** (`"all"`, or no `actor.inbox`): this export is everything, in the one App. Its route
 *   verifies the token, keys the event and hands it to the handler in process (`receive`, `clickOf`):
 *   no mailbox. The CLI installs only this export on a server, so nothing lives in the Worker's half alone.
 * - **Cloudflare** (`"one"`, each conversation's Durable Object): the Worker's half (worker.ts) serves
 *   the route and hands each event to its conversation's object through `actor.mailbox`; here
 *   `actor.inbox` handles `google-chat.event` (sent) and answers `google-chat.click` (called) with the
 *   same `receive` and `clickOf`. The routes are registered here too, where no server serves them, and
 *   hand events over through `actor.mailbox` as the Worker's do.
 *
 * What it does, by module (types.ts says who calls whom):
 * - ingress: route.ts, token.ts; admission: handler.ts, key.ts, attachments.ts, quote.ts;
 *   answers: transport.ts, format.ts, ids.ts, api.ts, auth.ts; "Thinking…": placeholder.ts;
 *   questions: question-cards.ts, click.ts.
 * - Answers are delivered by `startAnswerDelivery` (`@pikit/contracts`) from `agent.submissions`'
 *   feed, with each instance's transport (`draws: ["question"]`), `route`, `replyText` and `DELIVERY`;
 *   with `outbound.queue`, enqueued. It is woken when a message is admitted and when a run ends.
 * - The placeholder follows the runs of its conversations (never a dashboard request): `agent.started`
 *   creates it, `agent.partial` writes the answer into it, `agent.settled` / `agent.failed` delete what
 *   has nothing to send. A wakeup at start (`channel-google-chat.sweep`) deletes a crash's leftovers.
 * - The `conversations` setting is declared in `start`, when `settings` is installed (its dashboard
 *   section: `settings/index.tsx` of the component).
 *
 * Start reads every instance's secrets (a missing one fails it, P5) and builds clients; it makes no
 * request to Google: on Cloudflare every object runs it.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { type AgentResult, type ChannelTransport, type DeliveryPolicy, isDashboardRequest, type JsonValue, type RunSettlement, startAnswerDelivery } from "@pikit/contracts";
import { CALL_TIMEOUT_MS } from "./api.ts";
import { createClickHandler, createQuestionRecords } from "./click.ts";
import { type AddOnEvent, type AddOnResponse, readEvent } from "./event.ts";
import { createEventHandler } from "./handler.ts";
import { Config, createConversationSettings, type Instance, instanceOfKey, instancesOf, NAME } from "./instance.ts";
import { createAnswerTargets } from "./key.ts";
import { createPlaceholderMarks, createPlaceholders } from "./placeholder.ts";
import { questionCard } from "./question-cards.ts";
import { createJwks } from "./token.ts";
import { createTransport } from "./transport.ts";
import { CLICK_TYPE, type ClickHandler, EVENT_TYPE, type EventHandler, type EventSink, type Placeholders } from "./types.ts";
import { connect, mailboxSink, type Route, routeOf, serve } from "./worker.ts";

export { Config, NAME, WorkerConfig } from "./instance.ts";
export { CLICK_TYPE, EVENT_TYPE } from "./types.ts";
export { worker, WORKER_NAME } from "./worker.ts";

/** Its `storage.kv` namespace: `NAME`, written here so `registry validate` reads it. */
const NAMESPACE = "channel-google-chat";

/** The wakeup that deletes, at start, the placeholders a crash left. */
export const SWEEP = `${NAME}.sweep`;

/**
 * How answers are delivered (`startAnswerDelivery`): an answer that failed is tried again after 1 s,
 * 5 s, 30 s, then every minute (or after Google's `Retry-After`: a space takes one message write a
 * second), and logged as an error from its 3rd failure in a row; a run sends at most 20 pieces (a
 * Durable Object's subrequests, C4); a send not answered in 30 s may have reached Google (a piece's
 * send is up to two calls, plus a token).
 */
const DELIVERY: DeliveryPolicy = { retryMs: [1_000, 5_000, 30_000, 60_000], blockedAfter: 3, window: 200, piecesPerRun: 20, sendTimeoutMs: 2 * CALL_TIMEOUT_MS };

/** One instance while it runs. */
interface App {
  instance: Instance;
  route: Route;
  handle: EventHandler;
  click: ClickHandler;
  placeholders: Placeholders;
}

interface Running {
  apps: Map<string, App>;
  delivery: { wake(ctx: AppContext): Promise<void>; stop(signal?: AbortSignal): Promise<void> };
}

export default defineComponent({
  name: NAME,
  config: Config,
  setup(pikit, config) {
    const secrets = pikit.use("secrets");
    const registry = pikit.use("conversations.registry");
    const runtime = pikit.use("agent.runtime");
    const submissions = pikit.use("agent.submissions");
    const storage = pikit.use("storage.kv");
    const wakeups = pikit.use("wakeups");
    // Optional: answers stored before they are sent; the setting; where other files go; actors.
    const outbound = pikit.useOptional("outbound.queue");
    const settings = pikit.useOptional("settings");
    const workspace = pikit.useOptional("workspace");
    const execution = pikit.useOptional("execution");
    const inbox = pikit.useOptional("actor.inbox");
    const mailbox = pikit.useOptional("actor.mailbox");

    const instances = instancesOf(config.instances);
    const conversations = createConversationSettings(settings, instances, config.conversations);
    let running: Running | undefined;

    for (const instance of instances) {
      pikit.provideKeyed("http.route", `POST ${instance.path}`, (request, ctx) => serve(running?.apps.get(instance.instance)?.route, request, ctx));
    }

    /** The running instance whose conversation `key` is, or `undefined` (another channel's, or not running). */
    const appOf = (key: string): App | undefined => {
      const instance = instanceOfKey(instances, key);
      return instance === undefined ? undefined : running?.apps.get(instance.instance);
    };
    const wake = async (now: Running, key: string, ctx: AppContext): Promise<void> => {
      await now.delivery.wake(ctx).catch((error: unknown) =>
        ctx.logger.warn("channel-google-chat: could not ask for the delivery of an answer; it is delivered at the next wakeup", { conversation: key, error: String(error) }),
      );
    };

    /** A message, an add or a removal of the conversation `key`, handled where this App runs it; delivery woken after a message. */
    const receive = async (key: string, event: AddOnEvent, ctx: AppContext): Promise<void> => {
      const now = running;
      const app = appOf(key);
      if (now === undefined || app === undefined) throw new Error(`channel-google-chat: an event for "${key}" arrived, which is no conversation of a Chat app this channel runs (${instances.map((each) => each.instance).join(", ")})`);
      if ((await app.handle(key, event, ctx)) !== "done") await wake(now, key, ctx);
    };
    /** A click of the conversation `key`: the response Google shows. */
    const clickOf = async (key: string, event: AddOnEvent, ctx: AppContext): Promise<AddOnResponse> => {
      const app = appOf(key);
      if (app === undefined) throw new Error(`channel-google-chat: a click for "${key}" arrived, which is no conversation of a Chat app this channel runs`);
      return app.click(key, event, ctx);
    };
    const inProcess: EventSink = { event: receive, click: clickOf };
    /** What the mailbox carried, read back as an event. */
    const eventOf = (message: JsonValue): AddOnEvent => {
      const event = readEvent(message);
      if (event === undefined) throw new Error("channel-google-chat: the mailbox carried something that is not an add-on event of Chat");
      return event;
    };

    // The run's events: its placeholder, never for an operator's request from the dashboard.
    const placeholdersOf = (key: string, requestId: string): Placeholders | undefined => (isDashboardRequest(requestId) ? undefined : appOf(key)?.placeholders);
    const quietly = async (what: string, key: string, work: () => Promise<void>, ctx: AppContext): Promise<void> => {
      await work().catch((error: unknown) => ctx.logger.warn(`channel-google-chat: the placeholder could not be ${what}`, { conversation: key, error: String(error) }));
    };
    pikit.on("agent.started", async (event, ctx) => {
      const placeholders = placeholdersOf(event.conversation.key, event.requestId);
      if (placeholders !== undefined) await quietly("created", event.conversation.key, () => placeholders.started(event, ctx), ctx);
    });
    pikit.on("agent.partial", async (event, ctx) => {
      const placeholders = placeholdersOf(event.conversation.key, event.requestId);
      if (placeholders !== undefined) await quietly("updated", event.conversation.key, () => placeholders.partial(event, ctx), ctx);
    });
    const ended = async (result: AgentResult, ctx: AppContext): Promise<void> => {
      const now = running;
      if (now === undefined || appOf(result.conversation.key) === undefined) return;
      const placeholders = placeholdersOf(result.conversation.key, result.requestId);
      if (placeholders !== undefined) await quietly("settled", result.conversation.key, () => placeholders.settled(result, ctx), ctx);
      await wake(now, result.conversation.key, ctx);
    };
    pikit.on("agent.settled", ended);
    pikit.on("agent.failed", ended);

    return {
      async start(ctx) {
        // Where this App runs: every key's actor (a server) handles in process; one key's (a Durable
        // Object) is handed its conversation's events by the Worker, and hands on what its own routes get.
        const actors = inbox.get();
        const oneKey = actors !== undefined && actors.scope === "one";
        let sink = inProcess;
        if (oneKey) {
          const box = mailbox.get();
          if (box === undefined) throw new Error("channel-google-chat: in an App that is one conversation's actor, its routes hand events to their conversations through actor.mailbox, which is not installed");
          sink = mailboxSink(box);
        }

        const store = storage.get().namespace(NAMESPACE);
        const jwks = createJwks({ url: config.jwksUrl, clock: ctx.clock });
        const targets = createAnswerTargets(store);
        const marks = createPlaceholderMarks(store);
        const questions = createQuestionRecords(store);
        const apps = new Map<string, App>();
        const transports = new Map<string, ChannelTransport>();
        for (const instance of instances) {
          const connection = await connect(instance, { read: (name) => secrets.get().get(name), apiBase: config.apiBase, jwks, clock: ctx.clock, cache: store });
          const { credentials, api } = connection;
          const deps = {
            instance,
            credentials,
            api,
            targets,
            conversations: registry.get(),
            runtime: runtime.get(),
            store,
            workspace: workspace.get(),
            execution: execution.get(),
            clock: ctx.clock,
          };
          apps.set(instance.instance, {
            instance,
            route: routeOf(connection, { sink, mode: conversations.modeOf(instance.instance) }),
            handle: createEventHandler(deps),
            click: createClickHandler({ ...deps, questions }),
            placeholders: createPlaceholders({
              instance,
              api,
              targets,
              marks,
              submissions: submissions.get(),
              thinkingText: config.thinkingText,
              previewEveryMs: config.previewEveryMs,
              clock: ctx.clock,
            }),
          });
          transports.set(instance.instance, createTransport({ instance, credentials, api, targets, marks, questions, drawQuestion: questionCard }));
        }

        // Whatever ended while nothing ran (a restart, an eviction, a deploy) is delivered from now on.
        const delivery = await startAnswerDelivery(ctx, {
          name: NAME,
          answers: submissions.get().answers,
          store,
          transports,
          route: (key) => instanceOfKey(instances, key)?.instance,
          text: replyText,
          queue: outbound.get(),
          wakeups: wakeups.get(),
          policy: DELIVERY,
        });
        try {
          conversations.declare();
          running = { apps, delivery };
          if (oneKey) {
            actors.handle(EVENT_TYPE, (key, message, handlerCtx) => receive(key, eventOf(message), handlerCtx));
            actors.answer(CLICK_TYPE, async (key, message, handlerCtx) => (await clickOf(key, eventOf(message), handlerCtx)) as unknown as JsonValue);
          }
          // A crash's placeholders, deleted once this App runs (a wakeup: start makes no request).
          wakeups.get().handle(SWEEP, async (sweepCtx) => {
            for (const app of running?.apps.values() ?? []) await app.placeholders.sweep(sweepCtx);
          });
          await wakeups.get().at(SWEEP, ctx.clock.now(), ctx);
        } catch (error) {
          running = undefined;
          conversations.undeclare();
          await delivery.stop(ctx.abortSignal);
          throw error;
        }
      },

      async stop(ctx) {
        const stopping = running;
        running = undefined;
        conversations.undeclare();
        // A send in flight is cut, and its piece stays `sending`: sent again, with the same ids, at the next start.
        await stopping?.delivery.stop(ctx.abortSignal);
      },
    };
  },
});

/**
 * What a chat is told about a run: its answer, or that it failed. Nothing for an aborted or empty one
 * (its parts still go: a question). A message the runtime abandoned is never answered: the user is
 * asked to send it again. A failed run's words replace its placeholder.
 */
export function replyText(answer: Pick<RunSettlement, "kind" | "text" | "error">): string | undefined {
  if (answer.kind === "failed" && answer.error?.code === "abandoned") return "Sorry, we could not answer your message. Please send it again.";
  if (answer.kind === "failed") return `Sorry, something went wrong while answering (${answer.error?.code ?? "error"}). Try again in a moment.`;
  if (answer.kind === "completed" && (answer.text ?? "").trim() !== "") return answer.text;
  return undefined;
}
