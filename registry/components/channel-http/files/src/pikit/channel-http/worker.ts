/**
 * channel-http's Worker half, on Cloudflare (SPEC §4.1, C1): the same routes as a server's
 * (`routes.ts`), served by the Worker's App. It authenticates (`http.authenticate` runs here, where the
 * request is: a project's own stage of it goes in the Worker's App), reads the request, and calls the
 * conversation's object (`actor.mailbox.call` to `http:<conversationId>`), whose App (the default
 * export, `index.ts`) admits the message and answers as a server would (`backend.ts`).
 *
 * A message's call lasts until its answer, or until `replyTimeoutMs` (the object's half's config)
 * passed since it was admitted: the wait is inside the RPC's event, the only way an object keeps
 * waiting (a promise left after an event dies with it). It then answers `202`, the message durably
 * admitted in the object. An object that cannot be reached is `503 unavailable` with the request id.
 *
 * It requires `secrets` (`PIKIT_HTTP_TOKEN`) and `actor.mailbox` (actors-do). It has no config: how
 * long a POST waits is the object's.
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of pikit.config.ts. On a server it is not installed: the default export serves
 * the routes itself.
 */

import { defineComponent } from "@pikit/core";
import { type Digest, readToken } from "./auth.ts";
import { createRemoteBackend } from "./backend.ts";
import { provideRoutes } from "./routes.ts";

export const WORKER_NAME = "channel-http-worker";

export const worker = defineComponent({
  name: WORKER_NAME,
  setup(pikit) {
    const secrets = pikit.use("secrets");
    const mailbox = pikit.use("actor.mailbox");
    const backend = createRemoteBackend(() => mailbox.get());
    let token: Digest | undefined;

    provideRoutes(pikit, { token: () => token, backend: () => backend });

    return {
      async start() {
        token = await readToken((name) => secrets.get().get(name));
      },
      stop() {
        token = undefined;
      },
    };
  },
});
