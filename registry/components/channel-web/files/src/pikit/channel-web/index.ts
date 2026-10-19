/**
 * channel-web: people who are not operators talk to the assistant from a web page, `/chat/`, with
 * accounts of their own (features/completed/channel-web.md). Each user sees and continues only their own
 * conversations, watches the answer as it is written, attaches images and stops a run. The routes are
 * in `routes.ts`, their JSON in `api.ts`; the operator's (users, invitations, bans) in
 * `admin-routes.ts`, their JSON in `admin-api.ts`.
 *
 * - **Sender and key.** A message's sender is `{ channel: "web", id: <user id> }`, its conversation
 *   `web:<user id>:<chat id>` (`keyOf`, `chat.ts`), built from the session's user on every route.
 * - **Admission** through `admitInbound` (the router, `inbound.normalize`, duplicates by request id),
 *   its images with it; stored as the user's message once admitted (`store.ts`).
 * - **History.** A run that answered a user's message (not only `dashboard:` requests: an operator's
 *   follow-up is never the user's) is stored whole when it ends (`agent.settled`, `agent.failed`): its
 *   messages (`AgentResult.messages`: the assistant's, with thinking and tool calls, and the tools'
 *   results; never the runtime's user or system messages), in the turn of the user's message it
 *   answered (`store.ts`, `entries.ts`). An aborted or failed run keeps what it wrote.
 * - **Answers also take the channels' path**: `startAnswerDelivery` (with `outbound.queue` when
 *   installed), whose transport writes a completed run's answer into the channel's own table only when
 *   none of the run's messages are (its end never heard: `delivery.ts`).
 * - **States** of a user's message (`pending`, then `answered`, `failed`, `aborted`) move when its run
 *   ends, and from `agent.submissions` when the page reads a message still `pending` whose run's end no
 *   event brought (K3).
 * - **Live view** (`live.ts`): a projection of `agent.observe`'s `watch`, the dashboard's event shapes,
 *   only the user's runs.
 * - **Who a conversation is with**, for the dashboard (its stage of `conversation.describe`): its
 *   user's name and email, as the accounts know them (on Cloudflare one call to the accounts actor),
 *   its ids, and a link to the Web users page showing that user (`usersPagePath`).
 * - **What users see** (`visibility`: thinking, tools, context) and **the agents they may pick**
 *   (`agents`) are the operator's policy, cut in the routes (`visibility.ts`); with `signUp`, live
 *   settings when `settings` is installed (the dashboard's Settings), read at each request.
 *
 * Targets: `server` and `durable`. It never reads the target: in `start`, `actor.inbox`'s `scope` says
 * where it runs.
 * - **On a server** (`"all"`, or no `actor.inbox`) this export is everything: the routes, the accounts
 *   (better-auth over the App's `storage.sql`), the store (every conversation, and the list), delivery.
 * - **On Cloudflare** (`"one"`) it goes in each conversation's Durable Object: it admits the Worker's
 *   messages and answers its calls about this object's conversation (`calls.ts`), keeps its messages,
 *   delivers its answers, and tells the users' index (`channel-web.seen`) of each change. One object,
 *   `channel-web:accounts` (`ACCOUNTS_KEY`), holds the accounts and the index: it answers the Worker's
 *   `channel-web.auth.*` calls with its local accounts, made at the first. The routes are the Worker's
 *   half's (`worker.ts`); they are registered here too, where no server serves them.
 */

import { type AppContext, BACKGROUND_CONTEXT, defineComponent, withAbortSignal } from "@pikit/core";
import { type ActorInbox, type ActorMailbox, type AgentResult, type AnswerDelivery, answersOnlyTheDashboard, type ChannelTransport, type ConversationDescriber, describeStage, startAnswerDelivery } from "@pikit/contracts";
import Type from "typebox";
import { linkOrigin } from "./accounts/links.ts";
import type { Accounts } from "./accounts/types.ts";
import { avatarHosts, createAssets } from "./assets.ts";
import { createLocalBackend, stateOf } from "./backend.ts";
import { ACCOUNTS_KEY, answerConversationCalls, answerIndexCalls, SEEN } from "./calls.ts";
import { CHAT_FILES } from "./chat-files.ts";
import { parseKey } from "./chat.ts";
import type { ChatAgent } from "./api.ts";
import { Agents, type AccountSecrets, Config, configProblem, SignUp, type SignUpSettings, secretsOf, Visibility, type VisibilitySettings } from "./config.ts";
import { answerText, createTransport, DELIVERY, HEARD_WAIT_MS, INSTANCE, routeOf } from "./delivery.ts";
import { runEntryId, runMessages, userEntryOf } from "./entries.ts";
import { provideAdminRoutes } from "./admin-routes.ts";
import { createRateLimiter } from "./rate.ts";
import { createTitles } from "./titles.ts";
import { chatConfigOf, provideRoutes, type LiveSettings } from "./routes.ts";
import { type ConversationRow, createChatStore } from "./store.ts";
import { type AccountsWiring, BETTER_AUTH } from "./wiring.ts";

export { worker, WORKER_NAME } from "./worker.ts";
export { ACCOUNTS_KEY } from "./calls.ts";

export const NAME = "channel-web";

/** The dashboard's Web users page (the view's `BASE`), showing only `userId` (`?user=`, its search). */
export const usersPagePath = (userId: string): string => `/channel-web?user=${encodeURIComponent(userId)}`;

export interface ChannelWebOptions {
  /** How the accounts are made: better-auth's (the default), or a test's double. */
  accounts?: AccountsWiring;
  /** Wraps the transport into the channel's table: a test's platform that fails or hangs. */
  transport?: (inner: ChannelTransport) => ChannelTransport;
}

/** The settings an operator changes live (`settings`): who may sign up, what users see, the agents they may pick. */
const Settings = Type.Object({ signUp: SignUp, visibility: Visibility, agents: Agents }, { additionalProperties: false });
type Settings = { signUp: SignUpSettings; visibility: VisibilitySettings; agents: string[] };

/** The ends of runs kept (`heard`): a transport waits on one only shortly after it. */
const ENDS_KEPT = 1000;

export function createChannelWeb(options: ChannelWebOptions = {}) {
  const wiring = options.accounts ?? BETTER_AUTH;
  return defineComponent({
    name: NAME,
    config: Config,
    setup(pikit, config) {
      const secrets = pikit.use("secrets");
      const conversations = pikit.use("conversations.registry");
      const runtime = pikit.use("agent.runtime");
      const observe = pikit.use("agent.observe");
      // Answers come from the record of every run's end, from a cursor kept in storage.kv.
      const submissions = pikit.use("agent.submissions");
      const kv = pikit.use("storage.kv");
      // The store, and the accounts: the App's tables on a server; on Cloudflare each object's.
      const sql = pikit.use("storage.sql");
      const wakeups = pikit.useOptional("wakeups");
      const outbound = pikit.useOptional("outbound.queue");
      // Where it runs (`scope`); on Cloudflare the index is told through the mailbox.
      const inbox = pikit.useOptional("actor.inbox");
      const mailbox = pikit.useOptional("actor.mailbox");
      const settings = pikit.useOptional("settings");
      const email = pikit.useOptional("email.send");
      const auth = pikit.useOptional("admin.auth");
      // The agents users may pick (`agents`), described for the page.
      const definitions = pikit.useKeyed("agent.definition");
      const directory = pikit.useOptional("agent.directory");
      // Titles: a model's, through the runtime's models; each one given to the App's `/name` (admin-api's).
      const completion = pikit.useOptional("model.complete");
      const commands = pikit.useKeyed("agent.command");

      const store = createChatStore(() => sql.get());
      const assets = createAssets(CHAT_FILES, () => avatarHosts(config.signIn.social));
      /** Every message of a user passes here on a server, and through the accounts actor on Cloudflare. */
      const rate = createRateLimiter(config.messagesPerMinute);
      let declared = false;
      /** Whether a request's own host is trusted for links without PIKIT_PUBLIC_URL: on Cloudflare (the Worker's route), never on a server. */
      let trustHost = false;

      /** The operator's settings now (who may sign up, what users see, the agents they may pick), else the config's. */
      const liveSettings = async (ctx: AppContext): Promise<LiveSettings> => {
        const configured = { signUp: config.signUp, visibility: config.visibility, agents: config.agents };
        const live = settings.get();
        if (live === undefined || !declared) return configured;
        try {
          return await live.get<Settings>(NAME, ctx);
        } catch (error) {
          ctx.logger.warn("channel-web: its settings could not be read; its config applies", { error: error instanceof Error ? error.message : String(error) });
          return configured;
        }
      };
      const signUp = async (ctx: AppContext): Promise<SignUpSettings> => (await liveSettings(ctx)).signUp;

      /** The agents of `names` that are agents now (the code's, or live ones), in their order, described. */
      const agentsOf = async (names: readonly string[], ctx: AppContext): Promise<ChatAgent[]> => {
        if (names.length === 0) return [];
        const code = new Set(definitions.keys());
        const live = names.every((name) => code.has(name)) ? [] : ((await directory.get()?.list(ctx)) ?? []);
        return names.flatMap((name): ChatAgent[] => {
          if (code.has(name)) return [{ name }];
          const found = live.find((agent) => agent.name === name);
          return found === undefined ? [] : [{ name, ...(found.description !== undefined && found.description !== "" && { description: found.description }) }];
        });
      };

      /** Where the users' list is: the store itself (a server), or the accounts actor (Cloudflare). */
      let tell: (rows: ConversationRow[], ctx: AppContext) => Promise<void> = async () => {};
      const changed = async (row: ConversationRow, ctx: AppContext): Promise<void> => {
        try {
          await tell([row], ctx);
        } catch (error) {
          ctx.logger.warn("channel-web: the users' index did not take a conversation's change; its next change tells it again", {
            conversation: row.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      /** What outlives the events (a model's title): cancelled at stop. */
      let cancelling: AbortController | undefined;
      let background = BACKGROUND_CONTEXT;
      const titles = createTitles({
        store,
        kv: () => kv.get().namespace(NAME),
        complete: () => completion.get(),
        async modelFor(agent, ctx) {
          if (config.titleModel !== undefined) return config.titleModel;
          const defined = definitions.get(agent)?.model;
          if (defined !== undefined) return defined;
          return (await directory.get()?.list(ctx))?.find((each) => each.name === agent)?.model;
        },
        commands: () => commands,
        current: (key, ctx) => conversations.get().get(key, ctx),
        changed: (row, ctx) => changed(row, ctx),
      });

      /** `durable` once start found the App is one key's actor (a Durable Object). */
      let limits: "server" | "durable" = "server";
      let delivery: AnswerDelivery | undefined;
      let accounts: Accounts | undefined;
      let secretsRead: AccountSecrets | undefined;

      const backend = createLocalBackend({
        store,
        conversations: () => conversations.get(),
        runtime: () => runtime.get(),
        observe: () => observe.get(),
        submissions: () => submissions.get(),
        limits: () => limits,
        changed,
        titles,
        wake: async (ctx) => {
          await delivery?.wake(ctx).catch((error: unknown) => ctx.logger.warn("channel-web: could not ask for answers to be delivered; the next run's end does", { error: String(error) }));
        },
      });

      const accountsNow = (): Accounts => {
        if (accounts === undefined) throw new Error("channel-web: the accounts are not running here");
        return accounts;
      };
      /** The local accounts, made at the first use (on Cloudflare, only the accounts actor ever makes them). */
      const localAccounts = async (ctx: AppContext): Promise<Accounts> => {
        if (accounts !== undefined) return accounts;
        secretsRead ??= await secretsOf(config, (name) => secrets.get().get(name));
        accounts = wiring.local({ sql: () => sql.get(), config, secrets: secretsRead, signUp, email: email.get(), logger: ctx.logger, trustRequestHost: trustHost });
        ctx.logger.info("channel-web: the accounts are ready", { methods: [config.signIn.password && "password", config.signIn.magicLink && "magic-link", ...config.signIn.social, ...config.signIn.oidc.map((each) => each.id)].filter(Boolean) });
        return accounts;
      };

      /** The accounts actor's, reached through the mailbox: what a conversation's object reads a user from (on Cloudflare). */
      let remoteAccounts: Accounts | undefined;
      /**
       * Where this App reads its users: its own accounts (a server; the accounts actor), else, in a
       * conversation's object, the accounts actor's (one call).
       */
      const usersOf = async (ctx: AppContext): Promise<Pick<Accounts, "list">> => {
        if (accounts !== undefined || limits === "server") return localAccounts(ctx);
        const send = mailbox.get();
        if (send === undefined) throw new Error("channel-web: in a conversation's object the users are the accounts actor's, reached through actor.mailbox");
        if (remoteAccounts === undefined) {
          secretsRead ??= await secretsOf(config, (name) => secrets.get().get(name));
          remoteAccounts = wiring.remote({ mailbox: () => send, config, secret: secretsRead.secret, ...(secretsRead.publicUrl !== undefined && { publicUrl: secretsRead.publicUrl }) });
        }
        return remoteAccounts;
      };

      /** Who a conversation is with, for the dashboard: its user, as the accounts know them. */
      const describer: ConversationDescriber = {
        async describe(key, ctx) {
          const parsed = parseKey(key);
          if (parsed === undefined) return undefined;
          const party = { ids: [{ label: "User id", value: parsed.userId }, { label: "Chat id", value: parsed.chatId }] };
          try {
            const page = await (await usersOf(ctx)).list({ limit: 10, offset: 0, q: parsed.userId }, ctx);
            const user = page.items.find((each) => each.id === parsed.userId);
            if (user === undefined) return party;
            const name = user.name.trim();
            return { ...(name === "" ? { name: user.email } : { name, detail: user.email }), ...party, link: { label: "Web user", path: usersPagePath(parsed.userId) } };
          } catch (error) {
            ctx.logger.warn("channel-web: a conversation's user could not be read; it is described by its key", { conversation: key, error: error instanceof Error ? error.message : String(error) });
            return party;
          }
        },
      };

      /** The page's config, as this App's accounts make it (on Cloudflare the accounts actor answers the Worker with it). */
      const chatConfig = (ctx: AppContext) => chatConfigOf({ config, target: limits, settings: liveSettings, agents: agentsOf, email: email.get() !== undefined }, ctx);

      provideRoutes(pikit, { accounts: accountsNow, backend: () => backend, config, chatConfig, limits: () => limits, rate: async (userId, ctx) => rate.take(userId, ctx.clock.now()), assets });
      provideAdminRoutes(pikit, {
        auth,
        accounts: accountsNow,
        backend: () => backend,
        origin: (request) => linkOrigin(request.url, secretsRead?.publicUrl, trustHost),
      });
      pikit.pipeline("conversation.describe", describeStage(describer), { id: NAME });

      /** Logged, never thrown: an event's other listeners and the run go on. */
      const guarded = (what: string, work: (ctx: AppContext) => Promise<void>) => async (ctx: AppContext) => {
        try {
          await work(ctx);
        } catch (error) {
          ctx.logger.warn(`channel-web: ${what}`, { error: error instanceof Error ? error.message : String(error) });
        }
      };

      // A conversation being made here is named in the App's `/name` before any run of it can settle.
      pikit.on("agent.dispatched", ({ conversation }, ctx) => (parseKey(conversation.key) === undefined ? undefined : titles.dispatched(conversation, ctx)));
      pikit.on("agent.started", ({ conversation, requestId }, ctx) =>
        parseKey(conversation.key) === undefined
          ? undefined
          : guarded("a run's start was not recorded", async (now) => {
              // Before anything awaits: a view opened from now on names this run by it (`live.ts`).
              store.runStarted(conversation.conversationId, requestId);
              const row = await store.change(conversation.key, { busy: true });
              if (row !== undefined) await changed(row, now);
            })(ctx),
      );
      /** The ends of runs heard here, by `key` and the run's first request: their handling, done or going. */
      const ends = new Map<string, Promise<void>>();
      /** Resolves once the end of `run` of `key` was handled here, or after `HEARD_WAIT_MS` when it was not heard. */
      const heard = async (key: string, run: string): Promise<void> => {
        const id = `${key}\n${run}`;
        const deadline = Date.now() + HEARD_WAIT_MS;
        while (!ends.has(id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        await ends.get(id);
      };
      const ended = (result: AgentResult, ctx: AppContext) => {
        const parsed = parseKey(result.conversation.key);
        if (parsed === undefined) return undefined;
        const key = result.conversation.key;
        // An answer to the user: a model titles the conversation, in the background, once.
        if (result.kind === "completed" && !answersOnlyTheDashboard(result)) titles.settled(result.conversation, ctx.derive(() => background));
        const work = guarded("a run's end was not recorded; the page reads its state from agent.submissions, its answer from delivery", async (now) => {
          store.runEnded(result.conversation.conversationId);
          // What the run wrote, for the user: never a run only the operator's follow-ups started.
          let stored = 0;
          if (!answersOnlyTheDashboard(result)) {
            const messages = runMessages(result.messages).map((message) => {
              const at = (message as { timestamp?: unknown }).timestamp;
              return { id: runEntryId(result.requestId, message), message, at: typeof at === "number" ? at : now.clock.now() };
            });
            stored = await store.addRun(key, result.requestId, result.requestIds, messages);
          }
          const moved = await store.settle(key, result.requestIds, stateOf(result.kind));
          // What waited behind it, after it.
          const released = await store.release(key);
          if (stored > 0 || moved.length > 0) store.notify(key, { type: "changed" });
          for (const message of released) store.notify(key, { type: "entry", entry: userEntryOf(parsed.chatId, message) });
          const row = await store.change(key, { busy: false, ...(stored > 0 && { activity: now.clock.now() }) });
          if (row !== undefined) await changed(row, now);
          await delivery?.wake(now);
        })(ctx);
        ends.set(`${key}\n${result.requestId}`, work);
        for (const old of ends.keys()) {
          if (ends.size <= ENDS_KEPT) break;
          ends.delete(old);
        }
        return work;
      };
      pikit.on("agent.settled", ended);
      pikit.on("agent.failed", ended);

      const startDelivery = async (ctx: AppContext): Promise<void> => {
        const inner = createTransport({ store, now: () => ctx.clock.now(), changed: (row) => changed(row, ctx), heard });
        delivery = await startAnswerDelivery(ctx, {
          name: NAME,
          answers: submissions.get().answers,
          store: kv.get().namespace(NAME),
          transports: new Map([[INSTANCE, options.transport?.(inner) ?? inner]]),
          route: routeOf,
          text: answerText,
          queue: outbound.get(),
          wakeups: wakeups.get(),
          policy: DELIVERY,
        });
      };

      const placements = {
        /** Every key's actor (a server): everything here. */
        async all(ctx: AppContext): Promise<void> {
          if (config.signIn.magicLink && email.get() === undefined) throw new Error("channel-web: signIn.magicLink sends links by email: install an email.send provider (email-resend, email-ses), or turn it off");
          await localAccounts(ctx);
          if (secretsRead?.publicUrl === undefined) {
            ctx.logger.warn("channel-web: PIKIT_PUBLIC_URL is not set: sign-in and the accounts' links work only at localhost; set it to the chat's public origin to serve it to others");
          }
          await startDelivery(ctx);
          if (assets.built()) ctx.logger.info("channel-web: the chat page is served at /chat/", { files: assets.size() });
          else ctx.logger.info("channel-web: no chat page is built; the API alone is served at /chat/api/");
        },
        /** One key's actor (a Durable Object): this object's conversation, or the accounts actor. */
        async one(calls: ActorInbox, send: ActorMailbox, ctx: AppContext): Promise<void> {
          limits = "durable";
          // The Worker forwards the request as it reached it: its host is the Worker's route.
          trustHost = true;
          tell = (rows, now) => send.send(ACCOUNTS_KEY, SEEN, { rows: rows.map((row) => ({ ...row })) }, now);
          answerConversationCalls(calls, backend);
          answerIndexCalls(calls, store, chatConfig, rate);
          wiring.answer(calls, localAccounts);
          await startDelivery(ctx);
        },
      };

      return {
        async start(ctx) {
          cancelling = new AbortController();
          background = withAbortSignal(cancelling.signal, BACKGROUND_CONTEXT);
          const problem = configProblem(config);
          if (problem !== undefined) throw new Error(problem);
          const live = settings.get();
          if (live !== undefined) {
            live.declare(NAME, Settings, { signUp: config.signUp, visibility: config.visibility, agents: config.agents });
            declared = true;
          }
          const calls = inbox.get();
          if (calls === undefined || calls.scope === "all") return placements.all(ctx);
          const send = mailbox.get();
          if (send === undefined) throw new Error("channel-web: in an App that is one key's actor it tells the users' index, which needs actor.mailbox");
          return placements.one(calls, send, ctx);
        },
        async stop(ctx) {
          const stopping = delivery;
          delivery = undefined;
          accounts = undefined;
          remoteAccounts = undefined;
          secretsRead = undefined;
          declared = false;
          trustHost = false;
          // A write in flight is cut, and goes again (idempotent) at the next start.
          await stopping?.stop(ctx.abortSignal);
          // A title under way is cut: it is tried again after a later run.
          cancelling?.abort();
          await titles.idle();
        },
      };
    },
  });
}

export default createChannelWeb();
