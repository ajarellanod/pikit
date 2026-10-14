/**
 * channel-web's Worker half, on Cloudflare (SPEC §4.1, C1): the same routes as a server's
 * (`routes.ts`, `admin-routes.ts`), served by the Worker's App, over the remote backend (`remote.ts`:
 * each conversation's object, and the accounts actor's index for the list) and the remote accounts
 * (every call to the accounts actor, `channel-web:accounts`, but a session the signed cookie cache
 * vouches for, checked here). The page's files are bundled in (`chat-files.ts`).
 *
 * It needs `secrets` (`CHANNEL_WEB_AUTH_SECRET`, to check the cookie cache; `PIKIT_PUBLIC_URL` when
 * set) and `actor.mailbox` (actors-do); `admin.auth` for the operator's routes, `settings` for the
 * live sign-up mode, `email.send` to say whether the App sends email (the accounts actor sends it).
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of pikit.config.ts, under its own config key, `channel-web-worker`.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import Type from "typebox";
import type { Accounts } from "./accounts/types.ts";
import { provideAdminRoutes } from "./admin-routes.ts";
import { createAssets } from "./assets.ts";
import { CHAT_FILES } from "./chat-files.ts";
import { AUTH_SECRET, Config, configProblem, MIN_AUTH_SECRET, PUBLIC_URL, SignUp, type SignUpSettings } from "./config.ts";
import { createRemoteBackend } from "./remote.ts";
import { provideRoutes } from "./routes.ts";
import { type AccountsWiring, BETTER_AUTH } from "./wiring.ts";

export const WORKER_NAME = "channel-web-worker";

const Settings = Type.Object({ signUp: SignUp }, { additionalProperties: false });

/** The Worker's half, its accounts made by `wiring` (better-auth's remote, or a test's double). */
export function createChannelWebWorker(wiring: AccountsWiring = BETTER_AUTH) {
  return defineComponent({
    name: WORKER_NAME,
    config: Config,
    setup(pikit, config) {
      const secrets = pikit.use("secrets");
      const mailbox = pikit.use("actor.mailbox");
      const auth = pikit.useOptional("admin.auth");
      const settings = pikit.useOptional("settings");
      const email = pikit.useOptional("email.send");
      const assets = createAssets(CHAT_FILES);
      const backend = createRemoteBackend(() => mailbox.get());
      let accounts: Accounts | undefined;
      let publicUrl: string | undefined;
      let declared = false;

      const signUp = async (ctx: AppContext): Promise<SignUpSettings> => {
        const live = settings.get();
        if (live === undefined || !declared) return config.signUp;
        try {
          return (await live.get<{ signUp: SignUpSettings }>("channel-web", ctx)).signUp;
        } catch {
          return config.signUp;
        }
      };
      const accountsNow = (): Accounts => {
        if (accounts === undefined) throw new Error("channel-web: the accounts are not running here");
        return accounts;
      };

      provideRoutes(pikit, { accounts: accountsNow, backend: () => backend, config, signUp, limits: () => "durable", email: () => email.get() !== undefined, assets });
      provideAdminRoutes(pikit, { auth, accounts: accountsNow, backend: () => backend, origin: (request) => publicUrl ?? new URL(request.url).origin });

      return {
        async start(ctx) {
          const problem = configProblem(config);
          if (problem !== undefined) throw new Error(problem);
          const secret = (await secrets.get().get(AUTH_SECRET))?.trim() ?? "";
          if (secret.length < MIN_AUTH_SECRET) throw new Error(`channel-web: set ${AUTH_SECRET}, at least ${MIN_AUTH_SECRET} characters (a random one: openssl rand -base64 48)`);
          const url = (await secrets.get().get(PUBLIC_URL))?.trim();
          publicUrl = url === undefined || url === "" ? undefined : url.replace(/\/+$/, "");
          // Declared here too: the Worker reads it for the page (`GET /chat/api/config`), as the accounts actor for each sign-up.
          const live = settings.get();
          if (live !== undefined) {
            live.declare("channel-web", Settings, { signUp: config.signUp });
            declared = true;
          }
          accounts = wiring.remote({ mailbox: () => mailbox.get(), config, secret, ...(publicUrl !== undefined && { publicUrl }) });
          if (assets.built()) ctx.logger.info("channel-web: the chat page is served at /chat/", { files: assets.size() });
          else ctx.logger.info("channel-web: no chat page is built; the API alone is served at /chat/api/");
        },
        stop() {
          accounts = undefined;
          declared = false;
        },
      };
    },
  });
}

export const worker = createChannelWebWorker();
