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
 * - **Answers take the channels' path**: `startAnswerDelivery` (with `outbound.queue` when installed),
 *   whose transport writes each answer into the channel's own table (`delivery.ts`). A run only
 *   `dashboard:` requests started (an operator's follow-up) is never delivered: the user never sees it.
 * - **States** of a user's message (`pending`, then `answered`, `failed`, `aborted`) move when its run
 *   ends (`agent.settled`, `agent.failed`), and from `agent.submissions` when the page reads a message
 *   still `pending` whose run's end no event brought (K3).
 * - **Live view** (`live.ts`): a projection of `agent.observe`'s `watch`, only what the user may see.
 * - **Sign-up** (`signUp`) is a live setting when `settings` is installed: the dashboard's Settings.
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

import { type AppContext, defineComponent } from "@pikit/core";
import { type ActorInbox, type ActorMailbox, type AgentResult, type AnswerDelivery, type ChannelTransport, startAnswerDelivery } from "@pikit/contracts";
import Type from "typebox";
import { linkOrigin } from "./accounts/links.ts";
import type { Accounts } from "./accounts/types.ts";
import { avatarHosts, createAssets } from "./assets.ts";
import { createLocalBackend, stateOf } from "./backend.ts";
import { ACCOUNTS_KEY, answerConversationCalls, answerIndexCalls, SEEN } from "./calls.ts";
import { CHAT_FILES } from "./chat-files.ts";
import { parseKey } from "./chat.ts";
import { type AccountSecrets, Config, configProblem, SignUp, type SignUpSettings, secretsOf } from "./config.ts";
import { answerText, createTransport, DELIVERY, INSTANCE, routeOf } from "./delivery.ts";
import { provideAdminRoutes } from "./admin-routes.ts";
import { createRateLimiter } from "./rate.ts";
import { chatConfigOf, provideRoutes } from "./routes.ts";
import { type ConversationRow, createChatStore } from "./store.ts";
import { type AccountsWiring, BETTER_AUTH } from "./wiring.ts";

export { worker, WORKER_NAME } from "./worker.ts";
export { ACCOUNTS_KEY } from "./calls.ts";

export const NAME = "channel-web";

export interface ChannelWebOptions {
  /** How the accounts are made: better-auth's (the default), or a test's double. */
  accounts?: AccountsWiring;
  /** Wraps the transport into the channel's table: a test's platform that fails or hangs. */
  transport?: (inner: ChannelTransport) => ChannelTransport;
}

/** The settings an operator changes live (`settings`): who may sign up. */
const Settings = Type.Object({ signUp: SignUp }, { additionalProperties: false });
type Settings = { signUp: SignUpSettings };

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

      const store = createChatStore(() => sql.get());
      const assets = createAssets(CHAT_FILES, () => avatarHosts(config.signIn.social));
      /** Every message of a user passes here on a server, and through the accounts actor on Cloudflare. */
      const rate = createRateLimiter(config.messagesPerMinute);
      let declared = false;
      /** Whether a request's own host is trusted for links without PIKIT_PUBLIC_URL: on Cloudflare (the Worker's route), never on a server. */
      let trustHost = false;

      /** Who may sign up now: the operator's setting, else the config's. */
      const signUp = async (ctx: AppContext): Promise<SignUpSettings> => {
        const live = settings.get();
        if (live === undefined || !declared) return config.signUp;
        try {
          return (await live.get<Settings>(NAME, ctx)).signUp;
        } catch (error) {
          ctx.logger.warn("channel-web: its settings could not be read; signUp of its config applies", { error: error instanceof Error ? error.message : String(error) });
          return config.signUp;
        }
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

      /** The page's config, as this App's accounts make it (on Cloudflare the accounts actor answers the Worker with it). */
      const chatConfig = (ctx: AppContext) => chatConfigOf({ config, target: limits, signUp, email: email.get() !== undefined }, ctx);

      provideRoutes(pikit, { accounts: accountsNow, backend: () => backend, config, chatConfig, limits: () => limits, rate: async (userId, ctx) => rate.take(userId, ctx.clock.now()), assets });
      provideAdminRoutes(pikit, {
        auth,
        accounts: accountsNow,
        backend: () => backend,
        origin: (request) => linkOrigin(request.url, secretsRead?.publicUrl, trustHost),
      });

      /** Logged, never thrown: an event's other listeners and the run go on. */
      const guarded = (what: string, work: (ctx: AppContext) => Promise<void>) => async (ctx: AppContext) => {
        try {
          await work(ctx);
        } catch (error) {
          ctx.logger.warn(`channel-web: ${what}`, { error: error instanceof Error ? error.message : String(error) });
        }
      };

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
      const ended = (result: AgentResult, ctx: AppContext) =>
        parseKey(result.conversation.key) === undefined
          ? undefined
          : guarded("a run's end was not recorded; the page reads it from agent.submissions", async (now) => {
              const key = result.conversation.key;
              store.runEnded(result.conversation.conversationId);
              for (const id of await store.settle(key, result.requestIds, stateOf(result.kind))) store.notify(key, { type: "message", id });
              const row = await store.change(key, { busy: false });
              if (row !== undefined) await changed(row, now);
              await delivery?.wake(now);
            })(ctx);
      pikit.on("agent.settled", ended);
      pikit.on("agent.failed", ended);

      const startDelivery = async (ctx: AppContext): Promise<void> => {
        const inner = createTransport({ store, now: () => ctx.clock.now(), changed: (row) => changed(row, ctx) });
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
          const problem = configProblem(config);
          if (problem !== undefined) throw new Error(problem);
          const live = settings.get();
          if (live !== undefined) {
            live.declare(NAME, Settings, { signUp: config.signUp });
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
          secretsRead = undefined;
          declared = false;
          trustHost = false;
          // A write in flight is cut, and goes again (idempotent) at the next start.
          await stopping?.stop(ctx.abortSignal);
        },
      };
    },
  });
}

export default createChannelWeb();
