/**
 * channel-web's Worker half, on Cloudflare (SPEC §4.1, C1): the same routes as a server's
 * (`routes.ts`, `admin-routes.ts`), served by the Worker's App, over the remote backend (`remote.ts`:
 * each conversation's object, and the accounts actor's index for the list) and the remote accounts
 * (every call to the accounts actor, `channel-web:accounts`, but a session the signed cookie cache
 * vouches for, checked here). The page's files are bundled in (`chat-files.ts`).
 *
 * It needs `secrets` (`CHANNEL_WEB_AUTH_SECRET`, to check the cookie cache; `PIKIT_PUBLIC_URL` when
 * set) and `actor.mailbox` (actors-do); `admin.auth` for the operator's routes. The page's config
 * (`GET /chat/api/config`: the sign-in methods, the live sign-up mode, whether email is sent) is the
 * accounts actor's, whose App holds the accounts, their secrets and `email.send`: one call
 * (`channel-web.config`), its answer kept `CONFIG_CACHE_MS`.
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of pikit.config.ts, under its own config key, `channel-web-worker`.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { linkOrigin, publicUrlOf } from "./accounts/links.ts";
import type { Accounts } from "./accounts/types.ts";
import { provideAdminRoutes } from "./admin-routes.ts";
import type { ChatConfig } from "./api.ts";
import { avatarHosts, createAssets } from "./assets.ts";
import { ACCOUNTS_KEY, CALL } from "./calls.ts";
import { CHAT_FILES } from "./chat-files.ts";
import { AUTH_SECRET, Config, configProblem, MIN_AUTH_SECRET, PUBLIC_URL } from "./config.ts";
import { createRemoteBackend } from "./remote.ts";
import { provideRoutes } from "./routes.ts";
import { type AccountsWiring, BETTER_AUTH } from "./wiring.ts";

export const WORKER_NAME = "channel-web-worker";

/** How long the Worker keeps the accounts actor's page config: a sign-up mode changed live shows within it. */
export const CONFIG_CACHE_MS = 10_000;

/** The Worker's half, its accounts made by `wiring` (better-auth's remote, or a test's double). */
export function createChannelWebWorker(wiring: AccountsWiring = BETTER_AUTH) {
  return defineComponent({
    name: WORKER_NAME,
    config: Config,
    setup(pikit, config) {
      const secrets = pikit.use("secrets");
      const mailbox = pikit.use("actor.mailbox");
      const auth = pikit.useOptional("admin.auth");
      const assets = createAssets(CHAT_FILES, () => avatarHosts(config.signIn.social));
      const backend = createRemoteBackend(() => mailbox.get());
      let accounts: Accounts | undefined;
      let publicUrl: string | undefined;
      /** The accounts actor's last answer: the value only, never a promise another request awaits. */
      let cached: { at: number; value: ChatConfig } | undefined;

      const chatConfig = async (ctx: AppContext): Promise<ChatConfig> => {
        const now = ctx.clock.now();
        if (cached !== undefined && now - cached.at < CONFIG_CACHE_MS) return cached.value;
        const value = (await mailbox.get().call(ACCOUNTS_KEY, CALL.config, {}, ctx)) as unknown as ChatConfig;
        cached = { at: now, value };
        return value;
      };
      const accountsNow = (): Accounts => {
        if (accounts === undefined) throw new Error("channel-web: the accounts are not running here");
        return accounts;
      };

      // A user's messages are counted where every one of them passes: the accounts actor.
      const rate = async (userId: string, ctx: AppContext): Promise<number | undefined> =>
        ((await mailbox.get().call(ACCOUNTS_KEY, CALL.rate, { userId }, ctx)) as { retryAfter?: number }).retryAfter;

      provideRoutes(pikit, { accounts: accountsNow, backend: () => backend, config, chatConfig, limits: () => "durable", rate, assets });
      // The Worker's host is its route's: Cloudflare routes by it, so a client cannot make it another's.
      provideAdminRoutes(pikit, { auth, accounts: accountsNow, backend: () => backend, origin: (request) => linkOrigin(request.url, publicUrl, true) });

      return {
        async start(ctx) {
          const problem = configProblem(config);
          if (problem !== undefined) throw new Error(problem);
          const secret = (await secrets.get().get(AUTH_SECRET))?.trim() ?? "";
          if (secret.length < MIN_AUTH_SECRET) throw new Error(`channel-web: set ${AUTH_SECRET}, at least ${MIN_AUTH_SECRET} characters (a random one: openssl rand -base64 48)`);
          publicUrl = publicUrlOf(await secrets.get().get(PUBLIC_URL));
          accounts = wiring.remote({ mailbox: () => mailbox.get(), config, secret, ...(publicUrl !== undefined && { publicUrl }) });
          if (assets.built()) ctx.logger.info("channel-web: the chat page is served at /chat/", { files: assets.size() });
          else ctx.logger.info("channel-web: no chat page is built; the API alone is served at /chat/api/");
        },
        stop() {
          accounts = undefined;
          cached = undefined;
        },
      };
    },
  });
}

export const worker = createChannelWebWorker();
