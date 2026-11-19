/**
 * The bench's part, copied into the measured project as `src/bench/index.ts` and listed in its
 * Worker's App (`scripts/bench/project.ts`): two routes the bench drives from outside.
 *
 * - `GET /bench/ping`: answers at once; the first one after `wrangler dev` starts is the isolate's
 *   script start and the Worker's App start, the next ones what an HTTP round trip costs.
 * - `POST /bench/call` `{ key, type, message }`, with `authorization: Bearer $PIKIT_BENCH_TOKEN`:
 *   `actor.mailbox.call(key, type, message)` from the Worker, answered `{ ok, workerMs, code? }`.
 *   `workerMs` is the Worker's clock around the call: in workerd `Date.now()` moves only on I/O, so
 *   it is the call's wall time without the HTTP hop, never a CPU time.
 * - `POST /bench/ids` `{ keys }`, same token: `{ ids: { <key>: <object id> } }`, so the bench can tell
 *   which key each `pikit: object started` line (which logs the id, never the key) was.
 *
 * Not a kit component: no `component.json`, nothing in the registry; it exists only in a bench project.
 */

import { defineComponent } from "@pikit/core";
import { ActorCallError, isJsonObject, type JsonValue } from "@pikit/contracts";
import { WORKERS_HOST } from "@pikit/contracts/cloudflare";

interface Namespace {
  idFromName(name: string): { toString(): string };
}

export const BENCH_TOKEN = "PIKIT_BENCH_TOKEN";

export default defineComponent({
  name: "bench-worker",
  setup(pikit) {
    const mailbox = pikit.use("actor.mailbox");
    const secrets = pikit.use("secrets");
    let objects: Namespace | undefined;
    const authorized = async (request: Request) => {
      const token = await secrets.get().get(BENCH_TOKEN);
      return token !== undefined && request.headers.get("authorization") === `Bearer ${token}`;
    };
    const unauthorized = () => Response.json({ ok: false, code: "unauthorized" }, { status: 401 });

    pikit.provideKeyed("http.route", "GET /bench/ping", async () => Response.json({ ok: true }));

    pikit.provideKeyed("http.route", "POST /bench/ids", async (request) => {
      if (!(await authorized(request))) return unauthorized();
      const body = (await request.json()) as JsonValue;
      const keys = isJsonObject(body) && Array.isArray(body.keys) ? body.keys.filter((key): key is string => typeof key === "string") : [];
      if (objects === undefined) return Response.json({ ok: false, code: "no_binding" }, { status: 500 });
      const namespace = objects;
      return Response.json({ ok: true, ids: Object.fromEntries(keys.map((key) => [key, namespace.idFromName(key).toString()])) });
    });

    pikit.provideKeyed("http.route", "POST /bench/call", async (request, ctx) => {
      if (!(await authorized(request))) return unauthorized();
      const body = (await request.json()) as JsonValue;
      if (!isJsonObject(body) || typeof body.key !== "string" || typeof body.type !== "string") return Response.json({ ok: false, code: "invalid_request" }, { status: 400 });
      const started = Date.now();
      try {
        await mailbox.get().call(body.key, body.type, body.message ?? null, ctx);
        return Response.json({ ok: true, workerMs: Date.now() - started });
      } catch (error) {
        // A refusal still started the object: it is measured too, and the bench prints its code.
        const code = error instanceof ActorCallError ? error.code : "failed";
        return Response.json({ ok: false, code, message: error instanceof Error ? error.message : String(error), workerMs: Date.now() - started });
      }
    });

    return {
      start(ctx) {
        objects = ctx.value(WORKERS_HOST)?.env.CONVERSATION as Namespace | undefined;
      },
    };
  },
});
