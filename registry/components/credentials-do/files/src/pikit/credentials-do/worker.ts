/**
 * credentials-do's Worker half, on Cloudflare (SPEC §4.1, C1): the operator's routes, which the Worker
 * serves, each a call to the owner object (`calls.ts`). `pikit configure --login` uploads a login made
 * on the operator's machine here.
 *
 * | Route | What |
 * |---|---|
 * | `GET /admin/api/credentials-do` | `{ credentials: [{ providerId, type }] }`: what is stored, no secret |
 * | `PUT /admin/api/credentials-do/:providerId` | the body is pi-ai's `Credential` (`{ type: "oauth", access, refresh, expires, … }` or `{ type: "api_key", key }`) → `{ providerId, type }` |
 * | `DELETE /admin/api/credentials-do/:providerId` | `{ deleted }` |
 *
 * Every route asks `admin.auth` first (without a provider, nobody: `401`). No route ever answers a
 * credential, and none is logged: an operator can replace or delete one, never read it back. An
 * error is `{ error, message? }`.
 *
 * `component.json`'s `apps.worker` names this export (`worker`): `pikit add` puts it in
 * `export const worker` of pikit.config.ts, under its own name, `credentials-do-worker`.
 */

import { type AppContext, defineComponent } from "@pikit/core";
import { ActorCallError, type ActorMailbox, type JsonValue } from "@pikit/contracts";
import { CALL, CREDENTIALS_KEY, credentialOf, json, PROVIDER_ID, REFUSAL } from "./calls.ts";

export const WORKER_NAME = "credentials-do-worker";
export const ROUTE = "/admin/api/credentials-do";
/** A credential is a few hundred bytes; anything much bigger is not one. */
const MAX_BODY = 16 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const failure = (status: number, error: string, message?: string, headers: Record<string, string> = {}): Response =>
  Response.json({ error, ...(message !== undefined && { message }) }, { status, headers: { ...NO_STORE, ...headers } });

/** The provider id at the end of the path, or `undefined` when it is not one. */
function providerIdOf(request: Request): string | undefined {
  const last = new URL(request.url).pathname.split("/").at(-1) ?? "";
  let providerId: string;
  try {
    providerId = decodeURIComponent(last);
  } catch {
    return undefined;
  }
  return PROVIDER_ID.test(providerId) ? providerId : undefined;
}

export const worker = defineComponent({
  name: WORKER_NAME,
  setup(pikit) {
    const auth = pikit.useOptional("admin.auth");
    const mailbox = pikit.use("actor.mailbox");
    const ask = (type: string, message: JsonValue, ctx: AppContext) => (mailbox.get() as ActorMailbox).call(CREDENTIALS_KEY, type, message, ctx);

    /** An operator's route: `401` for anyone else; the owner's refusals as `400`; `503` when it cannot be reached. */
    const guarded =
      (work: (request: Request, ctx: AppContext) => Promise<Response>) =>
      async (request: Request, ctx: AppContext): Promise<Response> => {
        if ((await auth.get()?.verify(request, ctx)) === undefined) return failure(401, "unauthorized", undefined, { "www-authenticate": 'Bearer realm="pikit"' });
        try {
          return await work(request, ctx);
        } catch (error) {
          if (error instanceof ActorCallError && error.code === REFUSAL.invalid) return failure(400, error.code, error.message);
          // The owner's messages and the mailbox's hold no credential.
          ctx.logger.error("credentials-do: the owner object could not be reached", { error: error instanceof Error ? error.message : String(error) });
          return failure(503, "unavailable", "The credentials cannot be reached now: try again");
        }
      };

    pikit.provideKeyed(
      "http.route",
      `GET ${ROUTE}`,
      guarded(async (_request, ctx) => Response.json(await ask(CALL.list, null, ctx), { headers: NO_STORE })),
    );

    pikit.provideKeyed(
      "http.route",
      `PUT ${ROUTE}/:providerId`,
      guarded(async (request, ctx) => {
        const providerId = providerIdOf(request);
        if (providerId === undefined) return failure(400, REFUSAL.invalid, "The path ends with a provider id (lowercase letters, digits, \".\", \"_\", \"-\")");
        const text = await request.text();
        if (text.length > MAX_BODY) return failure(400, REFUSAL.invalid, "The body is too large for a credential");
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return failure(400, REFUSAL.invalid, "The body is not JSON");
        }
        const credential = credentialOf(body);
        // Says what is wrong with the shape, never what the body held.
        if (credential === undefined) return failure(400, REFUSAL.invalid, 'The body is a credential: { "type": "oauth", "access", "refresh", "expires" } or { "type": "api_key", "key" }');
        return Response.json(await ask(CALL.put, { providerId, credential: json(credential) }, ctx), { headers: NO_STORE });
      }),
    );

    pikit.provideKeyed(
      "http.route",
      `DELETE ${ROUTE}/:providerId`,
      guarded(async (request, ctx) => {
        const providerId = providerIdOf(request);
        if (providerId === undefined) return failure(400, REFUSAL.invalid, "The path ends with a provider id");
        return Response.json(await ask(CALL.delete, { providerId }, ctx), { headers: NO_STORE });
      }),
    );
  },
});
