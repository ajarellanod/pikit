/**
 * tool-mcp-oauth's Worker half, on Cloudflare (SPEC §4.1, C1): the operator's routes (`routes.ts`),
 * which the Worker serves, each a call to the owner object (`OWNER_KEY`). `pikit tool-mcp-oauth
 * login <server>` uploads a login made on the operator's machine here.
 *
 * Every route asks `admin.auth` first (without a provider, nobody: `401`). The owner, which has the
 * config, refuses a server not in it (`400`). No route answers a token, and none is logged.
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of pikit.config.ts, under its own name, `tool-mcp-oauth-worker`.
 */

import { defineComponent } from "@pikit/core";
import { OWNER_KEY } from "./calls.ts";
import { provideRoutes } from "./routes.ts";

export const WORKER_NAME = "tool-mcp-oauth-worker";

export const worker = defineComponent({
  name: WORKER_NAME,
  setup(pikit) {
    const auth = pikit.useOptional("admin.auth");
    const mailbox = pikit.use("actor.mailbox");
    provideRoutes(pikit, { auth, ask: (type, message, ctx) => mailbox.get().call(OWNER_KEY, type, message, ctx) });
  },
});
