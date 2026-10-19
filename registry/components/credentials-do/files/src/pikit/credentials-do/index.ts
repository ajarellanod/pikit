/**
 * credentials-do: the model providers' credentials on Cloudflare (`model.credentials`, pi-ai's
 * `CredentialStore`), API keys and subscription logins (OAuth tokens) alike, kept by one object.
 *
 * - **One copy.** The credentials are one object's, the owner (`CREDENTIALS_KEY`, of the
 *   conversations' class, never a conversation), in its `storage.sql`. This default export goes in
 *   every object's App: it provides `model.credentials` there (`remote.ts`: calls to the owner,
 *   through `actor.mailbox`), and it answers those calls (`owner.ts`; only the owner is called).
 * - **One refresh.** pi-ai refreshes an OAuth token inside `modify`, which runs under the owner's
 *   lock for that provider: one conversation refreshes, from the latest stored tokens, and those
 *   that found the token expiring meanwhile wait and get the new tokens. A failed refresh is
 *   reported to the run that needed it, and not tried again for `retryAfterMs`. Refresh tokens
 *   rotate: two refreshes at once would revoke one another's.
 * - **The OAuth flows bundled.** pi-ai loads a provider's OAuth flow with an import no bundler
 *   follows: `start` registers them statically (`bundleOAuthFlows`, `@pikit/pi-adapter/oauth-flows`),
 *   so a Worker can use and refresh a subscription's tokens.
 * - **Logged in from the operator's machine.** `pikit configure --login <provider>` runs pi-ai's
 *   login there and uploads the credential to the Worker's half (`worker.ts`, its routes behind
 *   `admin.auth`), which hands it to the owner.
 *
 * No credential is ever logged, put in an error, or answered by a route.
 *
 * Target: `durable`. On a server, `credentials-file` keeps them in a file.
 */

import { BACKGROUND_CONTEXT, type AppContext, defineComponent } from "@pikit/core";
import { bundleOAuthFlows } from "@pikit/pi-adapter/oauth-flows";
import Type from "typebox";
import { answerCalls, createOwner } from "./owner.ts";
import { createRemoteCredentials } from "./remote.ts";

export { CREDENTIALS_KEY } from "./calls.ts";
export { ROUTE, worker, WORKER_NAME } from "./worker.ts";

const Config = Type.Object({
  /** After a failed OAuth refresh, how long (ms) the owner refuses the next ones before it lets one try again. */
  retryAfterMs: Type.Integer({ minimum: 0, default: 60_000 }),
});

export default defineComponent({
  name: "credentials-do",
  config: Config,
  setup(pikit, config) {
    const sql = pikit.use("storage.sql");
    const inbox = pikit.use("actor.inbox");
    const mailbox = pikit.use("actor.mailbox");
    let context: AppContext | undefined;
    pikit.provide("model.credentials", createRemoteCredentials({ mailbox: () => mailbox.get(), context: () => context }));
    const owner = createOwner({ sql: () => sql.get(), clock: pikit.clock, retryAfterMs: config.retryAfterMs });
    return {
      start(ctx) {
        bundleOAuthFlows();
        context = ctx.derive(() => BACKGROUND_CONTEXT);
        answerCalls(inbox.get(), owner);
      },
      stop() {
        context = undefined;
      },
    };
  },
});
